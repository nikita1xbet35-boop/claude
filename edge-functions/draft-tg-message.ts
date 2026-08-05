// Supabase Edge Function: draft-tg-message
// ════════════════════════════════════════════════════════════════════════════
// Stage 3 of the Telegram outreach pipeline: DRAFTING.
//
// Writes the first message the OPERATOR will send by hand — personalised to the
// channel (name, geo, niche, size), in the channel's own language, ending in a
// question. It is stored on the row and shipped inside the lead card. This
// function does not, and cannot, send anything: it has no Telegram token and
// writes only to telegram_channels.draft_message.
//
// Rides the existing */15 Cloudflare tick.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY (+GROQ_KEY_2/3),
//      optional TG_MANAGER_USERNAME (default @aff_manager_xbet)

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_KEYS = [
  Deno.env.get('GROQ_API_KEY') || '',
  Deno.env.get('GROQ_KEY_2') || '',
  Deno.env.get('GROQ_KEY_3') || '',
].filter(Boolean);
const MANAGER = Deno.env.get('TG_MANAGER_USERNAME') || '@aff_manager_xbet';

const BATCH    = 10;
const DELAY_MS = 1500;
const MAX_LEN  = 700;

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
  for (let i = 0; i < n; i++) {
    const idx = (groqKeyIdx + i) % n;
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEYS[idx] },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status === 429 || res.status >= 500) { res.body?.cancel().catch(() => {}); continue; }
      if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
      const d = await res.json();
      groqKeyIdx = (idx + 1) % n;
      return d?.choices?.[0]?.message?.content || '';
    } catch { /* next key */ }
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

  const stats = { processed: 0, drafted: 0, failed: 0 };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    if (!GROQ_KEYS.length) return json({ ...stats, reason: 'no Groq key configured' });

    const { data: rows, error } = await supabase.from('telegram_channels')
      .select('id, channel_url, channel_name, subscribers, geo, language, niche, description, ai_score')
      .eq('status', 'new')
      .not('owner_contact', 'is', null)
      .is('draft_message', null)
      .order('ai_score', { ascending: false })
      .limit(BATCH);
    if (error) throw new Error(error.message);
    if (!rows?.length) return json({ ...stats, reason: 'nothing to draft' });

    for (const ch of rows as Row[]) {
      stats.processed++;
      const text = await draft(ch);
      if (!text) {
        // Left as-is: the row stays in 'new' and the next run retries it. Groq
        // being rate-limited must not burn a lead.
        stats.failed++;
        await sleep(DELAY_MS);
        continue;
      }
      await supabase.from('telegram_channels')
        .update({ draft_message: text, status: 'ready' }).eq('id', ch.id);
      await quiet(supabase.from('telegram_channel_log')
        .insert([{ channel_id: ch.id, action: 'drafted', metadata: { chars: text.length } }]));
      stats.drafted++;
      await sleep(DELAY_MS);
    }

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'draft-tg-message',
      message: `processed=${stats.processed} drafted=${stats.drafted} failed=${stats.failed}`,
    }]));

    return json(stats);
  } catch (e: any) {
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
