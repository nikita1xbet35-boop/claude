// Supabase Edge Function: draft-tg-message
// ════════════════════════════════════════════════════════════════════════════
// Stage 3 of the Telegram outreach pipeline: DRAFTING.
//
// Writes the first message the OPERATOR will send by hand — personalised to the
// channel (name, geo, niche, size), in the channel's own language, ending in a
// question. It is stored on the row and shipped inside the lead card. This
// function does not, and cannot, send anything: it has no Telegram token and
// writes only to tg_outreach_channels.draft_message.
//
// Rides the existing */15 Cloudflare tick.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY (+GROQ_KEY_1/2/3),
//      optional TG_MANAGER_USERNAME (default @aff_manager_xbet)

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// ── Model selection ─────────────────────────────────────────────────────────
// Groq decommissioned llama-3.1-8b-instant without warning and every call
// started coming back `HTTP 404: The model does not exist or you do not have
// access to it`. Seven functions named that model as a string literal, so the
// whole system went to zero in one step: search still found sites, DuckDuckGo
// was healthy, and not one candidate could be judged.
//
// A single hardcoded model is therefore a single point of failure owned by
// somebody else. This is a list: on a "model is gone" answer we advance to the
// next one and keep going, and the surviving model's name goes into the run log
// so the swap is visible rather than silent.
const GROQ_MODELS = [
  'llama-3.3-70b-versatile',   // current default
  'openai/gpt-oss-20b',
  'gemma2-9b-it',
  'llama-3.1-8b-instant',      // the retired one, kept last in case access returns
];
let groqModelIdx = 0;
const groqModel = () => GROQ_MODELS[groqModelIdx];
/** Does this failure mean the model itself is gone (as opposed to a bad request)? */
function groqModelGone(status: number, text: string): boolean {
  return (status === 404 || status === 400)
    && /does not exist|decommissioned|model[_ ]not[_ ]found|has been deprecated/i.test(text);
}

const GROQ_KEYS = [
  Deno.env.get('GROQ_API_KEY') || '',
  // GROQ_KEY_1 — четвёртый слот, добавлен когда Ник завёл три новых аккаунта.
  // Слотов было три (GROQ_API_KEY + _2 + _3), и секрет с именем GROQ_KEY_1 не
  // читал НИКТО: ни воркфлоу его не передавал, ни одна функция не забирала.
  // Ключ лежал бы в настройках и молча не работал — ровно тот случай, когда
  // всё выглядит настроенным и ничего не происходит.
  Deno.env.get('GROQ_KEY_1')   || '',
  Deno.env.get('GROQ_KEY_2') || '',
  Deno.env.get('GROQ_KEY_3') || '',
].filter(Boolean);
const MANAGER = Deno.env.get('TG_MANAGER_USERNAME') || '@aff_manager_xbet';

const BATCH       = 30;      // capped in practice by DEADLINE_MS below
const DELAY_MS    = 400;
const MAX_LEN     = 700;
const MIN_SCORE   = 40;      // judged here when scan could not score the row
const DEADLINE_MS = 110_000; // edge functions get ~150s; stop before the axe falls

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Best-effort await. A Supabase query builder is a thenable WITHOUT .catch, so
// `builder.catch(...)` throws TypeError instead of swallowing anything — a
// bookkeeping write has to be wrapped like this to stay non-fatal.
async function quiet(p: PromiseLike<unknown>): Promise<void> {
  try { await p; } catch { /* bookkeeping is best-effort */ }
}

// Languages we trust a 70b model to write natural outreach in. Anything else
// falls back to English — a clumsy message in a rare language reads worse to a
// channel owner than a clean English one.
const LANGS: Record<string, string> = {
  en: 'английском', ru: 'русском', fr: 'французском', pt: 'португальском',
  es: 'испанском', sw: 'суахили', ar: 'арабском', tr: 'турецком',
  de: 'немецком', it: 'итальянском', uk: 'украинском', hi: 'хинди',
};

let groqKeyIdx = 0;
async function groqChat(body: Record<string, unknown>): Promise<string | null> {
  const n = GROQ_KEYS.length;
  if (!n) return null;
  // Two passes over the key ring with a pause between. These keys are shared
  // with find-and-queue, which keeps them near their per-minute cap, so all
  // three can be 429 at one instant and fine a second later.
  for (let round = 0; round < 2; round++) {
    if (round) await sleep(2000);
    for (let i = 0; i < n; i++) {
      const idx = (groqKeyIdx + i) % n;
      try {
        // The model list can advance mid-run (see GROQ_MODELS), so stamp the
        // current choice onto the body at call time rather than at build time.
        (body as Record<string, unknown>).model = groqModel();
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEYS[idx] },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(25_000),
        });
        if (res.status === 429 || res.status >= 500) { res.body?.cancel().catch(() => {}); continue; }
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          // Model retired under us — every key answers the same, so advance the
          // model list rather than rotating keys.
          if (groqModelGone(res.status, errText) && groqModelIdx < GROQ_MODELS.length - 1) {
            groqModelIdx++;
            continue;
          }
          return null;
        }
        const d = await res.json();
        groqKeyIdx = (idx + 1) % n;
        return d?.choices?.[0]?.message?.content || '';
      } catch { /* next key */ }
    }
  }
  groqKeyIdx = (groqKeyIdx + 1) % n;
  return null;
}

/** Models like to wrap output in quotes, add a "Here is your message:" preamble,
 *  or sprinkle markdown. Strip all of it — this text goes out verbatim. */
function clean(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').trim();
  t = t.replace(/^(вот|here(?:'s| is)|сообщение|draft)[^\n:]{0,40}:\s*/i, '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('«') && t.endsWith('»'))) {
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|\s)[*_](\S[^*_]*?)[*_](\s|$)/g, '$1$2$3');
  return t.slice(0, MAX_LEN).trim();
}

interface Row {
  id: number; channel_url: string; channel_name: string | null;
  subscribers: number | null; geo: string | null; language: string | null;
  niche: string | null; description: string | null; ai_score: number | null;
}

/** Score a channel that reached this stage without a verdict.
 *
 *  scan keeps candidates Groq could not score (its keys are shared with
 *  find-and-queue and spend most of the day at their cap), which is right — the
 *  search result is the expensive part — but it means the quality filter would
 *  be off entirely if nothing ever scored them. Scoring HERE costs one call per
 *  channel that already has a contact, i.e. roughly 4% of what scan sees, and it
 *  happens exactly where a bad channel would otherwise become a card.
 *
 *  Returns null when Groq is unavailable: the row is left for the next run
 *  rather than let through unjudged. */
async function score(ch: Row): Promise<{ score: number; geo: string; language: string;
  niche: string; reasoning: string } | null> {
  const raw = await groqChat({
    model: groqModel(),
    messages: [{
      role: 'user',
      content: `Ты аналитик партнёрской программы букмекера 1xBet (фокус — Африка).
Оцени публичный Telegram-канал как потенциального партнёра-аффилиата.

Канал: ${ch.channel_name || ch.channel_url}
Ссылка: ${ch.channel_url}
Подписчиков: ${ch.subscribers ?? 'неизвестно'}
Описание: ${(ch.description || '').slice(0, 600)}

Высокий балл (70-100): канал с собственной аудиторией по ставкам/прогнозам/казино/Aviator, ведёт автор или команда, есть признаки монетизации.
Средний (40-69): тематика подходит, масштаб или авторство неясны.
Низкий (0-39): ОФИЦИАЛЬНЫЙ канал букмекера или конкурента (SportyBet, Betway, Bet9ja, 1xBet, Melbet и т.п.), новостной агрегатор, скам, не про ставки.

Верни СТРОГО JSON:
{"score":75,"geo":"NG","language":"en","niche":"betting_tips","reasoning":"кратко, 1 предложение"}
niche — одно из: betting_tips, casino, aviator, esports, crypto, sports_news, other.`,
    }],
    temperature: 0.1,
    max_tokens: 250,
    response_format: { type: 'json_object' },
  });
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw);
    return {
      score: Math.max(0, Math.min(100, Number(p.score) || 0)),
      geo: String(p.geo || '').slice(0, 8),
      language: String(p.language || '').slice(0, 8),
      niche: String(p.niche || 'other').slice(0, 40),
      reasoning: String(p.reasoning || '').slice(0, 500),
    };
  } catch { return null; }
}

async function draft(ch: Row): Promise<string | null> {
  const langCode = (ch.language || '').toLowerCase().slice(0, 2);
  const langName = LANGS[langCode] || LANGS.en;
  const subs = ch.subscribers ? `${ch.subscribers.toLocaleString('en-US')} подписчиков` : 'размер неизвестен';

  const raw = await groqChat({
    model: 'llama-3.3-70b-versatile',
    messages: [{
      role: 'user',
      content: `Ты аффилиат-менеджер 1xBet. Напиши ПЕРВОЕ сообщение владельцу Telegram-канала.

Канал: ${ch.channel_name || ch.channel_url}
Ссылка: ${ch.channel_url}
Тематика: ${ch.niche || 'ставки'}
ГЕО: ${ch.geo || 'не определено'}
Аудитория: ${subs}
Описание канала: ${(ch.description || '').slice(0, 400)}

Требования:
1. Пиши на ${langName} языке.
2. Ровно 2-3 предложения. Коротко — это холодное сообщение в личку.
3. Первое предложение — конкретно про ЭТОТ канал (название/тематика/ГЕО), не шаблонный комплимент.
4. Упомяни партнёрскую программу 1xBet и ставку до 40% RevShare.
5. Закончи вопросом (интересно ли обсудить) и укажи контакт ${MANAGER}.
6. Дружелюбно и по-деловому. Без CAPS, без эмодзи-спама (максимум один эмодзи), без обещаний выигрышей.

Верни ТОЛЬКО текст сообщения — без кавычек, без markdown, без пояснений.`,
    }],
    temperature: 0.7,
    max_tokens: 300,
  });
  if (!raw) return null;
  const text = clean(raw);
  return text.length >= 40 ? text : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { processed: 0, drafted: 0, failed: 0, rejected: 0, unjudged: 0 };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  const startedAt = Date.now();

  try {
    if (!GROQ_KEYS.length) return json({ ...stats, reason: 'no Groq key configured' });

    const { data: rows, error } = await supabase.from('tg_outreach_channels')
      .select('id, channel_url, channel_name, subscribers, geo, language, niche, description, ai_score')
      .eq('status', 'new')
      .not('owner_contact', 'is', null)
      .is('draft_message', null)
      .order('ai_score', { ascending: false, nullsFirst: false })
      .limit(BATCH);
    if (error) throw new Error(error.message);
    if (!rows?.length) return json({ ...stats, reason: 'nothing to draft' });

    for (const ch of rows as Row[]) {
      // Each draft is committed as it lands, so stopping early just defers the
      // rest to the next tick.
      if (Date.now() - startedAt > DEADLINE_MS) break;
      stats.processed++;

      // Judge first, if scan could not. A channel that fails here never becomes
      // a card — this is where the official-bookmaker and off-topic channels
      // that scan waved through unscored get stopped.
      if (ch.ai_score === null) {
        const v = await score(ch);
        if (!v) { stats.unjudged++; await sleep(DELAY_MS); continue; }
        Object.assign(ch, { geo: v.geo || ch.geo, language: v.language || ch.language,
          niche: v.niche || ch.niche, ai_score: v.score });
        if (v.score < MIN_SCORE) {
          await supabase.from('tg_outreach_channels').update({
            ai_score: v.score, ai_reasoning: v.reasoning, geo: ch.geo, language: ch.language,
            niche: ch.niche, status: 'rejected', reviewed_at: new Date().toISOString(),
            notes: `score ${v.score} < ${MIN_SCORE}`,
          }).eq('id', ch.id);
          stats.rejected++;
          await sleep(DELAY_MS);
          continue;
        }
        await supabase.from('tg_outreach_channels').update({
          ai_score: v.score, ai_reasoning: v.reasoning,
          geo: ch.geo, language: ch.language, niche: ch.niche,
        }).eq('id', ch.id);
      }

      const text = await draft(ch);
      if (!text) {
        // Left as-is: the row stays in 'new' and the next run retries it. Groq
        // being rate-limited must not burn a lead.
        stats.failed++;
        await sleep(DELAY_MS);
        continue;
      }
      await supabase.from('tg_outreach_channels')
        .update({ draft_message: text, status: 'ready' }).eq('id', ch.id);
      await quiet(supabase.from('tg_outreach_log')
        .insert([{ channel_id: ch.id, action: 'drafted', metadata: { chars: text.length } }]));
      stats.drafted++;
      await sleep(DELAY_MS);
    }

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'draft-tg-message',
      message: `processed=${stats.processed} drafted=${stats.drafted} failed=${stats.failed} `
        + `rejected=${stats.rejected} unjudged=${stats.unjudged}`,
    }]));

    return json(stats);
  } catch (e: any) {
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
