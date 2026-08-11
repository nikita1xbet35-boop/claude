// Supabase Edge Function: extract-tg-contact
// ════════════════════════════════════════════════════════════════════════════
// Stage 2 of the Telegram outreach pipeline: OWNER CONTACT.
//
// Reads the PUBLIC channel page (https://t.me/<name>) AND the public post feed
// (https://t.me/s/<name>) — the same pages any browser gets, no login, no API,
// no private invites — and pulls the contact the owner published themselves: an
// email, an @username, or a contact bot. The feed matters: the first live run
// found a contact on only 1 of 8 channels from the bio alone, because owners
// put "for ads write to @x" in a pinned or recent post far more often.
// Also refreshes the real subscriber count and description, which the search
// snippet could only guess at.
//
// Nothing here messages anyone. A channel with no published contact ends as
// status='no_contact' and leaves the pipeline.
//
// Contact detection is regex-first: emails and @handles in a bio are found
// deterministically and for free. Groq is only asked to disambiguate when the
// bio offers several candidates (cross-promo channels sit next to the admin
// handle), which keeps this off the shared Groq quota most of the time.
//
// Rides the existing */15 Cloudflare tick.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY (+GROQ_KEY_2/3)

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GROQ_KEYS = [
  Deno.env.get('GROQ_API_KEY') || '',
  Deno.env.get('GROQ_KEY_2') || '',
  Deno.env.get('GROQ_KEY_3') || '',
].filter(Boolean);

const BATCH          = 40;     // capped in practice by DEADLINE_MS below
const MAX_ATTEMPTS   = 5;      // then the page is called dead and stops being retried
const MIN_SUBS       = 1000;   // below this a channel is not worth a manual message
const MAX_STALE_DAYS = 7;      // no post in this long → the channel reads as abandoned
const DELAY_MS       = 700;    // between channels — still ~1 req/s at t.me
const FETCH_MS       = 10_000;
const DEADLINE_MS    = 110_000; // edge functions get ~150s; stop before the axe falls

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ── Page parsing ────────────────────────────────────────────────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function metaContent(html: string, prop: string): string {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
  return decodeEntities(html.match(re)?.[1] || html.match(alt)?.[1] || '');
}

/** "12.3K subscribers" / "1 234 members" / "5,6 тыс. подписчиков" → 12300 */
function parseSubscribers(html: string): number | null {
  const extra = html.match(/class="tgme_page_extra"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  const text = decodeEntities(extra || '');
  const m = text.match(/([\d][\d\s.,]*?)\s*([KkMmКкМм])?\s*(subscribers|members|подписчик|участник)/i);
  if (!m) return null;
  // "1 234" / "1,234" are thousands separators; so is a dot followed by exactly
  // three digits ("1.234"), while "12.3K" keeps its decimal point.
  const num = parseFloat(m[1].replace(/[\s,]/g, '').replace(/\.(?=\d{3}\b)/g, ''));
  if (!Number.isFinite(num)) return null;
  const unit = m[2] || '';
  const mult = /[MmМм]/.test(unit) ? 1_000_000 : /[KkКк]/.test(unit) ? 1_000 : 1;
  return Math.round(num * mult);
}

interface Page {
  ok: boolean; dead: boolean; name: string; description: string;
  subscribers: number | null; links: string[];
  posts: string; postLinks: string[]; lastPostAt: string | null;
}

/** Every rendered message carries `<time datetime="2024-06-01T12:00:00+00:00">`.
 *  The feed lists oldest→newest, so the LAST match on the page is the newest
 *  post — that is the number that decides whether a channel is still alive. */
function parseLastPostDate(html: string): string | null {
  const re = /class="tgme_widget_message_date"[^>]*>\s*<time[^>]+datetime="([^"]+)"/gi;
  let latest: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) latest = m[1];
  if (!latest) return null;
  const d = new Date(latest);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The public post feed at t.me/s/<name>. The bio alone is a thin source — the
 *  first live run found a contact on 1 of 8 channels — because owners put "for
 *  ads write to @x" in a pinned or recent post far more often than in the bio.
 *  Same public page a browser gets; no login, no API. */
async function fetchPreview(name: string): Promise<{ posts: string; links: string[]; lastPostAt: string | null }> {
  try {
    const res = await fetch(`https://t.me/s/${name}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(FETCH_MS),
      redirect: 'follow',
    });
    if (!res.ok) { res.body?.cancel().catch(() => {}); return { posts: '', links: [], lastPostAt: null }; }
    const html = (await res.text()).slice(0, 600_000);

    const texts: string[] = [];
    const msgRe = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let m: RegExpExecArray | null;
    while ((m = msgRe.exec(html)) !== null && texts.length < 25) {
      const t = decodeEntities(m[1]);
      if (t) texts.push(t);
    }

    // Only links inside message bodies — the page chrome is full of Telegram's own.
    const links: string[] = [];
    const bodyRe = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    while ((m = bodyRe.exec(html)) !== null && links.length < 60) {
      const hrefRe = /href="(mailto:[^"]+|https?:\/\/[^"]+)"/gi;
      let h: RegExpExecArray | null;
      while ((h = hrefRe.exec(m[1])) !== null && links.length < 60) links.push(h[1]);
    }
    return { posts: texts.join('\n').slice(0, 12_000), links, lastPostAt: parseLastPostDate(html) };
  } catch { return { posts: '', links: [], lastPostAt: null }; }
}

async function fetchChannelPage(url: string): Promise<Page> {
  const empty: Page = { ok: false, dead: false, name: '', description: '', subscribers: null, links: [], posts: '', postLinks: [], lastPostAt: null };
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(FETCH_MS),
      redirect: 'follow',
    });
  } catch { return empty; }

  if (res.status === 404 || res.status === 410) {
    res.body?.cancel().catch(() => {});
    return { ...empty, dead: true };
  }
  if (!res.ok) { res.body?.cancel().catch(() => {}); return empty; }

  const html = (await res.text()).slice(0, 400_000);

  // A username that never existed still returns 200, but with Telegram's generic
  // landing page instead of a channel block — that is the "dead" signal.
  if (!/tgme_page_title|tgme_page_description|og:description/i.test(html)) {
    return { ...empty, dead: true };
  }

  const title = decodeEntities(
    html.match(/class="tgme_page_title"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '',
  ) || metaContent(html, 'og:title');

  const description = decodeEntities(
    html.match(/class="tgme_page_description[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '',
  ) || metaContent(html, 'og:description');

  // Links the owner put in the bio — Telegram renders them as real <a href>.
  const links: string[] = [];
  const linkRe = /href="(mailto:[^"]+|https?:\/\/[^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < 40) links.push(m[1]);

  // The post feed is a second, richer source for the owner contact.
  const preview = await fetchPreview(url.split('/').pop() || '');

  return {
    ok: true, dead: false, name: title, description,
    subscribers: parseSubscribers(html), links,
    posts: preview.posts, postLinks: preview.links, lastPostAt: preview.lastPostAt,
  };
}

// ── Contact candidates ──────────────────────────────────────────────────────
const CONTACT_HINTS = [
  'contact', 'admin', 'owner', 'ads', 'advert', 'promo', 'business', 'partner',
  'collab', 'cooperation', 'manager', 'pr ', 'dm ', 'inbox', 'write', 'reach',
  'реклам', 'сотруднич', 'связ', 'по вопрос', 'админ', 'владел', 'партнёр', 'партнер',
  'publicit', 'contactez', 'anunci', 'parceria', 'wasiliana', 'matangazo',
];

interface Cand { value: string; type: 'email' | 'username' | 'bot'; weight: number }

/** Pull contact candidates out of the bio text + bio links, weighting each by
 *  whether the owner labelled it ("ads: @x" scores above a bare @x). */
function candidates(desc: string, links: string[], self: string): Cand[] {
  const out = new Map<string, Cand>();
  const lower = desc.toLowerCase();
  const labelled = (idx: number) => {
    const before = lower.slice(Math.max(0, idx - 80), idx);
    return CONTACT_HINTS.some(h => before.includes(h));
  };
  const add = (value: string, type: Cand['type'], weight: number) => {
    const key = value.toLowerCase();
    const prev = out.get(key);
    if (!prev || prev.weight < weight) out.set(key, { value, type, weight });
  };

  // Emails: a published email in a channel bio is essentially always the owner's.
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = emailRe.exec(desc)) !== null) add(m[0], 'email', labelled(m.index) ? 4 : 3);
  for (const l of links) {
    if (l.toLowerCase().startsWith('mailto:')) add(l.slice(7).split('?')[0], 'email', 4);
  }

  // @handles in the bio. The lookbehind keeps the local part of an email from
  // being re-read as a handle ("owner@tipsng.com" is not a @tipsng mention).
  const handleRe = /(?<![A-Za-z0-9._%+-])@([A-Za-z0-9_]{4,32})/g;
  while ((m = handleRe.exec(desc)) !== null) {
    const h = m[1];
    if (h.toLowerCase() === self.toLowerCase()) continue;     // the channel itself
    add('@' + h, /bot$/i.test(h) ? 'bot' : 'username', labelled(m.index) ? 3 : 1);
  }

  // t.me links in the bio — same thing in href form.
  for (const l of links) {
    const h = l.match(/^https?:\/\/(?:www\.)?t\.me\/([A-Za-z0-9_]{4,32})(?:[/?#]|$)/i)?.[1];
    if (!h || h.toLowerCase() === self.toLowerCase()) continue;
    if (['s', 'share', 'joinchat', 'proxy', 'addstickers'].includes(h.toLowerCase())) continue;
    add('@' + h, /bot$/i.test(h) ? 'bot' : 'username', 2);
  }

  return [...out.values()].sort((a, b) => b.weight - a.weight);
}

// ── Groq disambiguation ─────────────────────────────────────────────────────
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
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEYS[idx] },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 429 || res.status >= 500) { res.body?.cancel().catch(() => {}); continue; }
        if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
        const d = await res.json();
        groqKeyIdx = (idx + 1) % n;
        return d?.choices?.[0]?.message?.content || '';
      } catch { /* next key */ }
    }
  }
  groqKeyIdx = (groqKeyIdx + 1) % n;
  return null;
}

/** Which candidate is the owner/ads contact?
 *  { ok: false }              — Groq unreachable; the caller should retry later
 *                               rather than guess (a wrong contact means the
 *                               operator messages a random subscriber chat).
 *  { ok: true, value: null }  — Groq says none of them is a contact.  */
async function pickContact(
  desc: string, cands: Cand[],
): Promise<{ ok: false } | { ok: true; value: string | null }> {
  const raw = await groqChat({
    model: 'llama-3.1-8b-instant',
    messages: [{
      role: 'user',
      content: `Описание публичного Telegram-канала:
"""${desc.slice(0, 1200)}"""

Кандидаты в контакты владельца/рекламного менеджера:
${cands.map((c, i) => `${i}. ${c.value} (${c.type})`).join('\n')}

Какой из них — контакт ДЛЯ СВЯЗИ по рекламе/сотрудничеству (владелец, админ, менеджер)?
Не выбирай ссылки на другие каналы, чаты подписчиков, зеркала и сайты букмекеров.
Верни СТРОГО JSON: {"choice": <номер или -1 если ни один не подходит>}`,
    }],
    temperature: 0,
    max_tokens: 60,
    response_format: { type: 'json_object' },
  });
  if (raw === null) return { ok: false };
  try {
    const idx = Number(JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw)?.choice);
    if (Number.isInteger(idx) && idx >= 0 && idx < cands.length) {
      return { ok: true, value: cands[idx].value };
    }
  } catch { /* unparseable — treat as "no contact" */ }
  return { ok: true, value: null };
}

// ── Main ────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { processed: 0, found: 0, no_contact: 0, dead: 0, too_small: 0, too_stale: 0, retry: 0 };
  const json = (s: unknown, code = 200) => new Response(JSON.stringify(s),
    { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

  const startedAt = Date.now();

  try {
    const { data: rows, error } = await supabase.from('tg_outreach_channels')
      .select('id, channel_url, ai_score, attempts, subscribers, last_post_at')
      .eq('status', 'new')
      .is('owner_contact', null)
      .lt('attempts', MAX_ATTEMPTS)
      .order('ai_score', { ascending: false, nullsFirst: false })
      .limit(BATCH);
    if (error) throw new Error(error.message);
    if (!rows?.length) return json({ ...stats, reason: 'nothing to extract' });

    for (const ch of rows) {
      // Every channel already handled is committed, so stopping early costs
      // nothing — the next tick picks up where this one left off.
      if (Date.now() - startedAt > DEADLINE_MS) break;
      stats.processed++;
      const self = ch.channel_url.split('/').pop() || '';
      const attempts = (ch.attempts ?? 0) + 1;
      const page = await fetchChannelPage(ch.channel_url);

      const finish = async (patch: Record<string, unknown>, action: string, meta?: unknown) => {
        await supabase.from('tg_outreach_channels').update({ ...patch, attempts }).eq('id', ch.id);
        await quiet(supabase.from('tg_outreach_log')
          .insert([{ channel_id: ch.id, action, metadata: (meta ?? null) as any }]));
      };

      if (page.dead) {
        stats.dead++;
        await finish({ status: 'dead', notes: 'channel page not found' }, 'dead');
        await sleep(DELAY_MS);
        continue;
      }

      if (!page.ok) {
        // Transient (timeout, 5xx, rate limit). Bump attempts and retry next run;
        // MAX_ATTEMPTS stops a permanently broken page from blocking the queue.
        if (attempts >= MAX_ATTEMPTS) {
          stats.dead++;
          await finish({ status: 'dead', notes: `unreachable after ${attempts} attempts` }, 'dead');
        } else {
          stats.retry++;
          await supabase.from('tg_outreach_channels').update({ attempts }).eq('id', ch.id);
        }
        await sleep(DELAY_MS);
        continue;
      }

      // last_post_at is recorded on every reachable page, whether or not the
      // channel survives the filters below — that is what makes "how many of
      // the found channels are actually alive" answerable from the base later.
      const base: Record<string, unknown> = {
        subscribers: page.subscribers ?? ch.subscribers ?? null,
        description: page.description ? page.description.slice(0, 2000) : null,
        // Falls back to what we already knew, exactly like subscribers above: a
        // re-run whose preview fetch failed to parse must not erase a freshness
        // timestamp we successfully read earlier — that would turn a known-live
        // channel back into "freshness unknown" and disarm the stale filter.
        last_post_at: page.lastPostAt ?? ch.last_post_at ?? null,
      };
      if (page.name) base.channel_name = page.name.slice(0, 200);

      // Audience size is the first hard filter: a 50-subscriber channel is not
      // worth a hand-written message regardless of how well it scored on a snippet.
      if (page.subscribers !== null && page.subscribers < MIN_SUBS) {
        stats.too_small++;
        await finish(
          { ...base, status: 'rejected', notes: `too small (${page.subscribers} subs)`, reviewed_at: new Date().toISOString() },
          'rejected', { reason: 'too_small', subscribers: page.subscribers },
        );
        await sleep(DELAY_MS);
        continue;
      }

      // Second filter: a channel that has not posted in MAX_STALE_DAYS reads as
      // abandoned — a cold message to its owner is unlikely to get a reply, and
      // subscriber counts on dead channels are stale numbers, not a live audience.
      // Only fires when the date is actually known: a preview that failed to load
      // (feed disabled, timeout) must not read as "stale" — that would reject a
      // live channel for a fetch hiccup instead of leaving it to retry.
      if (page.lastPostAt) {
        const ageDays = (Date.now() - new Date(page.lastPostAt).getTime()) / 86_400_000;
        if (ageDays > MAX_STALE_DAYS) {
          stats.too_stale++;
          await finish(
            { ...base, status: 'rejected', notes: `no post in ${Math.round(ageDays)}d`, reviewed_at: new Date().toISOString() },
            'rejected', { reason: 'stale', last_post_at: page.lastPostAt, age_days: Math.round(ageDays) },
          );
          await sleep(DELAY_MS);
          continue;
        }
      }

      // Bio first, then the post feed. A post-sourced contact is weighted one
      // step lower: posts are full of cross-promo @mentions, while anything in
      // the bio the owner deliberately put there.
      const bioCands = candidates(page.description, page.links, self);
      const postCands = candidates(page.posts, page.postLinks, self)
        .map(c => ({ ...c, weight: Math.max(1, c.weight - 1) }));
      const merged = new Map<string, Cand>();
      for (const c of [...bioCands, ...postCands]) {
        const k = c.value.toLowerCase();
        const prev = merged.get(k);
        if (!prev || prev.weight < c.weight) merged.set(k, c);
      }
      const cands = [...merged.values()].sort((a, b) => b.weight - a.weight);

      if (!cands.length) {
        stats.no_contact++;
        await finish({ ...base, status: 'no_contact', contact_type: 'none' }, 'extracted', { contact: null });
        await sleep(DELAY_MS);
        continue;
      }

      // A published email, or a single handle the owner explicitly labelled
      // ("for ads: @x"), is taken as-is. Anything weaker — a bare @mention that
      // is just as likely to be a subscriber chat or a cross-promo — goes to the
      // model, because the cost of a wrong contact is the operator cold-messaging
      // the wrong person.
      const best = cands[0];
      const tied = cands.filter(c => c.weight === best.weight).length > 1;
      let chosen: string | null = best.value;

      if (!(best.type === 'email' || (best.weight >= 3 && !tied))) {
        const pick = await pickContact(page.description + '\n' + page.posts.slice(0, 1500), cands);
        if (!pick.ok && attempts < MAX_ATTEMPTS) {
          // Groq down/rate-limited: leave the row in 'new' and retry next run
          // rather than committing a guess.
          stats.retry++;
          await supabase.from('tg_outreach_channels').update({ attempts }).eq('id', ch.id);
          await sleep(DELAY_MS);
          continue;
        }
        // Out of retries — go with the top-weighted candidate. The operator
        // still reviews the card before anything is sent.
        chosen = pick.ok ? pick.value : best.value;
      }

      if (!chosen) {
        stats.no_contact++;
        await finish({ ...base, status: 'no_contact', contact_type: 'none' }, 'extracted', { contact: null });
        await sleep(DELAY_MS);
        continue;
      }

      const type = cands.find(c => c.value.toLowerCase() === chosen!.toLowerCase())?.type
        ?? (chosen.includes('@') && !chosen.startsWith('@') ? 'email' : 'username');

      stats.found++;
      await finish(
        { ...base, owner_contact: chosen, contact_type: type },
        'extracted', { contact: chosen, type, candidates: cands.length },
      );
      await sleep(DELAY_MS);
    }

    await quiet(supabase.from('error_log').insert([{
      level: 'info', service: 'extract-tg-contact',
      message: `processed=${stats.processed} found=${stats.found} no_contact=${stats.no_contact} `
        + `dead=${stats.dead} small=${stats.too_small} stale=${stats.too_stale}`,
    }]));

    return json(stats);
  } catch (e: any) {
    return json({ ...stats, error: String(e?.message || e) }, 500);
  }
});
