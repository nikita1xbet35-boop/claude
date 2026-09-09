// Supabase Edge Function: dispatch-tasks
// ════════════════════════════════════════════════════════════════════════════
// Диспетчер расписания. Воркер будит его раз в минуту, он смотрит в
// scheduled_tasks и решает, что запускать.
//
// ── Почему это edge-функция, а не код внутри воркера ────────────────────────
// Сначала диспетчер жил в scheduledHandler() воркера — и не работал ни одного
// тика. Воркер ходит в базу под ANON-ключом, а миграция 062 закрыла
// scheduled_tasks для anon: первый же запрос отдавал 403, ошибку глотал
// try/catch, и конвейер простоял 41 час, выглядя при этом живым.
//
// Дело не в правах, которые «надо было выдать»: диспетчер меняет расписание —
// занимает блокировки, пишет статусы, отключает задачи. Выдать это анонимному
// ключу, который лежит открытым текстом в index.html, значило бы позволить
// любому желающему остановить систему одним запросом.
//
// Здесь ключ service_role, как у всех остальных функций. Воркеру остаётся
// ровно одна обязанность — разбудить раз в минуту.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const nowIso = () => new Date().toISOString();

/** Лучшее усилие: запись в журнал не должна ронять сам тик. */
async function log(level: string, message: string) {
  try {
    await supabase.from('error_log').insert([{ level, service: 'dispatch-tasks', message }]);
  } catch (_) { /* журнал — не критичный путь */ }
}

async function alert(level: string, message: string, custom_text: string) {
  try {
    await fetch(FUNCTIONS_URL + '/send-alert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
      },
      body: JSON.stringify({ level, service: 'dispatcher', message, custom_text }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (_) { /* алерт не доставлен — тик всё равно должен доработать */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats: Record<string, unknown> = {
    stale_unlocked: 0, due: 0, ran: 0, lagging: 0, tasks: [] as string[],
  };

  try {
    // ── 1. Снять протухшие блокировки ───────────────────────────────────────
    // Задача, чей вызов умер посреди работы, осталась бы залоченной навсегда —
    // то есть молча перестала бы запускаться. Это ровно тот класс поломки,
    // ради которого весь блок затевался, поэтому снятие идёт первым.
    //
    // Помечаем timeout, а не просто разлочиваем: «упало по таймауту» и «ни
    // разу не запускалось» — разные диагнозы, и в last_status они должны
    // различаться.
    const { data: locked } = await supabase.from('scheduled_tasks')
      .select('id, name, locked_at, lock_ttl_sec').not('locked_at', 'is', null);
    const staleIds = (locked || [])
      .filter((t: any) => Date.parse(t.locked_at) + t.lock_ttl_sec * 1000 < Date.now())
      .map((t: any) => t.id);
    if (staleIds.length) {
      await supabase.from('scheduled_tasks')
        .update({ locked_at: null, last_status: 'timeout' }).in('id', staleIds);
      stats.stale_unlocked = staleIds.length;
      await log('warning', `снял ${staleIds.length} протухших блокировок`);
    }

    // ── 2. Кому пора ────────────────────────────────────────────────────────
    const { data: tasks, error: tErr } = await supabase.from('scheduled_tasks')
      .select('id, name, handler, interval_sec, priority, pipeline, last_run_at, consecutive_errors')
      .eq('enabled', true).is('locked_at', null).order('priority');
    if (tErr) throw tErr;

    // ── 3. Пайплайны на паузе ───────────────────────────────────────────────
    // pipeline_limits остаётся хозяином этой настройки: диспетчер её читает,
    // а не заменяет собой.
    const { data: limits } = await supabase.from('pipeline_limits').select('pipeline, paused');
    const paused = new Set((limits || []).filter((l: any) => l.paused).map((l: any) => l.pipeline));

    const due = (tasks || [])
      .filter((t: any) => !t.pipeline || !paused.has(t.pipeline))
      .filter((t: any) => !t.last_run_at
        || Date.parse(t.last_run_at) + t.interval_sec * 1000 <= Date.now())
      // При нехватке слотов важен не только приоритет, но и насколько задача
      // просрочена: иначе низкоприоритетная задача, обойдённая один раз, будет
      // обойдена и во все следующие тики.
      .map((t: any) => ({
        ...t,
        overdue: t.last_run_at
          ? (Date.now() - Date.parse(t.last_run_at)) / (t.interval_sec * 1000)
          : Infinity,
      }))
      .sort((a: any, b: any) => a.priority - b.priority || b.overdue - a.overdue);
    stats.due = due.length;

    // Сколько задач за тик. Строгое «одна за тик» не выдерживает арифметики:
    // набору нужно ~6000 запусков в сутки при 1440 тиках. Значение живёт в
    // system_config, чтобы менять темп без деплоя.
    let maxPerTick = 8;
    try {
      const { data: cfg } = await supabase.from('system_config')
        .select('value').eq('key', 'dispatcher_max_per_tick').maybeSingle();
      const v = parseInt(String(cfg?.value ?? ''), 10);
      if (Number.isFinite(v) && v > 0) maxPerTick = v;
    } catch (_) { /* умолчания достаточно */ }

    // ── 4. Занять под блокировку ДО запуска ─────────────────────────────────
    // Условие is('locked_at', null) в самом UPDATE — это и есть защита от
    // двойного запуска: если параллельный тик успел забрать задачу, наш UPDATE
    // не тронет ни строки, и мы её пропустим.
    const claimed: any[] = [];
    for (const t of due.slice(0, maxPerTick)) {
      const { data: rows } = await supabase.from('scheduled_tasks')
        .update({ locked_at: nowIso() })
        .eq('id', t.id).is('locked_at', null).select('id');
      if (rows && rows.length) claimed.push(t);
    }

    // ── 5. Выполнить и записать результат ───────────────────────────────────
    await Promise.all(claimed.map(async (t: any) => {
      const started = Date.now();
      let status = 'ok';
      let errText: string | null = null;
      try {
        const res = await fetch(FUNCTIONS_URL + '/' + t.handler, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_KEY,
            Authorization: 'Bearer ' + SUPABASE_KEY,
          },
          body: JSON.stringify({ cron: true }),
          // Функции сами себя ограничивают ~110 секундами; явный предел нужен,
          // чтобы блокировка снялась в этом же вызове, а не по TTL.
          signal: AbortSignal.timeout(115_000),
        });
        if (!res.ok) {
          status = 'error';
          errText = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        }
      } catch (e: any) {
        status = (e?.name === 'TimeoutError' || e?.name === 'AbortError') ? 'timeout' : 'error';
        errText = String(e?.message ?? e).slice(0, 300);
      }

      const errs = status === 'ok' ? 0 : (t.consecutive_errors || 0) + 1;
      const patch: Record<string, unknown> = {
        last_run_at: nowIso(),
        last_status: status,
        last_error: errText,
        last_duration_ms: Date.now() - started,
        consecutive_errors: errs,
        locked_at: null,
      };

      // Десять падений подряд — сломанная задача, которая жжёт слоты у
      // работающих. Одна ошибка при этом ничего не выключает: временный сбой
      // сети не должен останавливать конвейер.
      if (errs >= 10) {
        patch.enabled = false;
        await alert('error', `${t.name}: ${errs} ошибок подряд, задача отключена`,
          `🔴 <b>Задача отключена</b>\n\n<code>${t.name}</code> упала ${errs} раз подряд `
          + `и снята с расписания.\n\nПоследняя ошибка:\n<code>${(errText || '').slice(0, 200)}</code>\n\n`
          + `Включить обратно:\n<code>UPDATE scheduled_tasks SET enabled=true, `
          + `consecutive_errors=0 WHERE name='${t.name}';</code>`);
      }

      // Блокировка не снялась — её подберёт шаг 1 следующего тика по TTL.
      await supabase.from('scheduled_tasks').update(patch).eq('id', t.id);
      (stats.tasks as string[]).push(`${t.name}:${status}`);
    }));
    stats.ran = claimed.length;

    // ── 6. Кто отстал больше чем на пять интервалов ─────────────────────────
    // Тот самый сценарий, который полтора месяца никто не замечал: задача не
    // падает и не ругается — её просто никто не запускает. Ошибок нет, значит
    // и алертов по ошибкам нет. Ловится только по времени.
    const { data: all } = await supabase.from('scheduled_tasks')
      .select('name, enabled, interval_sec, last_run_at, consecutive_errors');
    const lagging = (all || []).filter((t: any) => {
      if (!t.enabled) return true;                 // выключенная тоже на глаза
      if (!t.last_run_at) return false;            // ещё ни разу — разберётся сам
      return Date.now() - Date.parse(t.last_run_at) > t.interval_sec * 5000;
    });
    stats.lagging = lagging.length;

    if (lagging.length) {
      // Раз в час, а не на каждом тике: иначе за сутки набежит 1440
      // одинаковых сообщений и читать их перестанут в первый же день.
      const marker = `dispatcher_lag_alert_${Math.floor(Date.now() / 3_600_000)}`;
      const { data: ins } = await supabase.from('system_config')
        .upsert({ key: marker, value: lagging.length }, { onConflict: 'key', ignoreDuplicates: true })
        .select('key');
      if (ins && ins.length) {
        // Маркер на каждый час иначе копился бы по 24 строки в сутки.
        await supabase.from('system_config')
          .delete().like('key', 'dispatcher_lag_alert_%').neq('key', marker);

        const lines = lagging.slice(0, 12).map((t: any) => {
          if (!t.enabled) return `• <code>${t.name}</code> — выключена (${t.consecutive_errors} ошибок)`;
          const mins = Math.round((Date.now() - Date.parse(t.last_run_at)) / 60000);
          return `• <code>${t.name}</code> — ${mins} мин назад, ждём каждые ${Math.round(t.interval_sec / 60)} мин`;
        }).join('\n');
        await alert('warning', `${lagging.length} задач отстают от расписания`,
          `⏱ <b>Задачи отстают от расписания</b>\n\n${lines}\n\n`
          + `Состояние целиком:\n<code>SELECT name, enabled, last_run_at, last_status, `
          + `consecutive_errors FROM scheduled_tasks ORDER BY priority;</code>`);
      }
    }

    await log('info',
      `тик: запущено ${claimed.length} из ${due.length} готовых, отстают ${lagging.length}`);

    return new Response(JSON.stringify(stats), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    // Диспетчер, упавший молча, останавливает всю систему и выглядит при этом
    // живым — так уже было. Пишем громко.
    await log('critical', `диспетчер упал: ${e?.message ?? e}`);
    return new Response(JSON.stringify({ ...stats, error: String(e?.message ?? e) }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
