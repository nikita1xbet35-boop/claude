// Supabase Edge Function: youtube-search
// On-demand YouTube channel finder for the dashboard "YouTube" tab. Unlike the
// email/form pipeline, this NEVER auto-sends: it just builds a searchable base of
// betting/tipster channels with every contact we can pull (email / Telegram /
// WhatsApp / links), stored in telegram_channels (partner_type='youtube'). The
// operator works the base by hand and can push a channel into the send pipeline
// later from the UI.
//
// Called from the dashboard: POST { geos: string[], min_subscribers, max_per_geo }.
// Uses the YouTube Data API (env YOUTUBE_API_KEY). Deploy: --no-verify-jwt.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), YOUTUBE_API_KEY
// (deploy trigger: partner-bases migrations 008/009 ship with this run)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const YT_KEY       = Deno.env.get('YOUTUBE_API_KEY') || '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// GEO → localized channel-search query (Africa-focus week: betting tipsters / cappers).
// Several query variants per GEO so we surface DIFFERENT channels over time — a
// single fixed query returns the same top ~8 channels every run (saved=0). The
// cron rotates the variant by time slot; manual search picks one at random.
const GEO_QUERY_SETS: Record<string, string[]> = {
  NG: ['betting tips nigeria', 'aviator predictor nigeria', 'sure odds naija', 'sportybet prediction', 'naija football prediction', 'mega jackpot prediction nigeria'],
  KE: ['betting tips kenya', 'sportpesa mega jackpot prediction', 'aviator kenya', 'sure odds kenya', 'betika jackpot prediction', 'odibets tips'],
  GH: ['betting tips ghana', 'aviator ghana', 'sure odds ghana', 'football prediction ghana', 'sportybet ghana', 'jackpot prediction ghana'],
  TZ: ['betting tips tanzania', 'utabiri mpira', 'aviator tanzania', 'sportpesa tanzania', 'mabingwa tips', 'jackpot prediction tanzania'],
  UG: ['betting tips uganda', 'aviator uganda', 'sure odds uganda', 'football prediction uganda', 'betpawa uganda', 'jackpot prediction uganda'],
  CM: ['pronostic paris sportif cameroun', 'aviator cameroun', 'pronostic foot cameroun', '1xbet cameroun', 'parier football cameroun', 'coupon pronostic cameroun'],
  CI: ['pronostic paris sportif cote d ivoire', 'aviator cote d ivoire', 'pronostic foot ivoirien', '1xbet ci', 'coupon sur foot abidjan', 'parier cote d ivoire'],
  SN: ['pronostic paris sportif senegal', 'aviator senegal', 'pronostic foot senegal', '1xbet senegal', 'parier dakar', 'coupon pronostic senegal'],
  BF: ['pronostic paris sportif burkina', 'aviator burkina', 'pronostic foot burkina', '1xbet burkina', 'parier ouaga', 'coupon pronostic burkina'],
  ZM: ['betting tips zambia', 'aviator zambia', 'sure odds zambia', 'football prediction zambia', 'betway zambia', 'jackpot prediction zambia'],
  CD: ['pronostic paris sportif rdc', 'aviator congo', 'pronostic foot rdc', '1xbet rdc', 'parier kinshasa', 'coupon pronostic congo'],
  ET: ['betting tips ethiopia', 'aviator ethiopia', 'sure odds ethiopia', 'football prediction ethiopia', 'hulusport betting', 'jackpot prediction ethiopia'],
  MZ: ['dicas apostas mocambique', 'aviator mocambique', 'prognosticos futebol mocambique', 'apostas desportivas mocambique', 'palpites futebol', 'betway mocambique'],
  ML: ['pronostic paris sportif mali', 'aviator mali', 'pronostic foot mali', '1xbet mali', 'parier bamako', 'coupon pronostic mali'],
};

// Rotate the query variant: cron advances by time slot (so the same GEO asks a
// different question on later ticks); manual search picks a random variant.
function pickQuery(geo: string, isCron: boolean): string {
  const set = GEO_QUERY_SETS[geo] || [`betting tips ${geo}`];
  if (isCron) return set[Math.floor(Date.now() / (7 * 60 * 1000)) % set.length];
  return set[Math.floor(Math.random() * set.length)];
}

// ── Contact extraction ──────────────────────────────────────────────────────
const EMAIL_REGEX  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_IGNORE = ['noreply', 'no-reply', 'example', 'youtube.com', 'sentry', '.png', '.jpg', '.gif'];
const URL_REGEX    = /https?:\/\/[^\s)"'<>]+/gi;

function validEmail(e: string): boolean {
  if (!e || e.length > 100) return false;
  const l = e.toLowerCase();
  if (EMAIL_IGNORE.some(ig => l.includes(ig))) return false;
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(e);
}

interface Contacts { email: string | null; telegram: string | null; whatsapp: string | null; links: string[] }

function extractContacts(text: string): Contacts {
  const t = text || '';
  const email = [...new Set(t.match(EMAIL_REGEX) || [])].filter(validEmail)[0] || null;

  const urls = [...new Set(t.match(URL_REGEX) || [])].map(u => u.replace(/[.,;]+$/, ''));

  // Telegram: t.me / telegram.me links, else a "telegram @handle" mention.
  let telegram: string | null =
    urls.find(u => /(?:t\.me|telegram\.me|telegram\.dog)\//i.test(u)) || null;
  if (!telegram) {
    const m = t.match(/(?:telegram|телеграм|тг|tg)\s*[:\-—]?\s*@([a-zA-Z0-9_]{4,})/i);
    if (m) telegram = 'https://t.me/' + m[1];
  }

  // WhatsApp: wa.me / chat.whatsapp / api.whatsapp links, else "whatsapp +<phone>".
  let whatsapp: string | null =
    urls.find(u => /(?:wa\.me|whatsapp\.com|chat\.whatsapp\.com|api\.whatsapp\.com)/i.test(u)) || null;
  if (!whatsapp) {
    const m = t.match(/whatsapp[^\d+]{0,12}(\+?\d[\d\s\-]{7,15}\d)/i);
    if (m) whatsapp = m[1].replace(/[\s\-]/g, '');
  }

  // Other links (site / linktree / socials) — exclude the ones captured above + youtube.
  const links = urls.filter(u =>
    !/youtube\.com|youtu\.be|t\.me|telegram\.me|telegram\.dog|wa\.me|whatsapp\.com/i.test(u));

  return { email, telegram, whatsapp, links: [...new Set(links)].slice(0, 6) };
}

async function ytApi(path: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, key: YT_KEY }).toString();
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`,
    { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API ${path} → HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

const MAX_AGE_DAYS = 30;      // only channels active within the last 30 days
const MIN_SUBS_FLOOR = 1000;  // default subscriber floor (dashboard + cron)

// Latest upload date via the channel's uploads playlist (cheap — 1 quota unit).
async function latestVideoDate(uploadsPlaylistId: string | undefined): Promise<Date | null> {
  if (!uploadsPlaylistId) return null;
  try {
    const pl = await ytApi('playlistItems', {
      part: 'contentDetails', playlistId: uploadsPlaylistId, maxResults: '1',
    });
    const d = pl?.items?.[0]?.contentDetails?.videoPublishedAt;
    return d ? new Date(d) : null;
  } catch (_) { return null; }
}

function scoreOf(c: Contacts): number {
  let s = 40;
  if (c.email)    s += 20;
  if (c.telegram) s += 15;
  if (c.whatsapp) s += 10;
  if (c.links.length) s += 10;
  return Math.min(s, 100);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    if (!YT_KEY) {
      return new Response(JSON.stringify({ success: false, error: 'YOUTUBE_API_KEY not configured' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    const body = await req.json().catch(() => ({}));

    // ── Cron mode: the worker fires this on a timer so the base fills on its own.
    // Each tick searches ONE rotating GEO (100 quota units) and we cap the number
    // of cron searches per day so we never burn the 10k/day YouTube quota. Manual
    // dashboard searches (body.geos present) bypass this and are operator-paced.
    const isCron = !!body.cron && !(Array.isArray(body.geos) && body.geos.length);
    if (isCron) {
      const DAILY_CRON_SEARCHES = 72;                 // 72 × 100 = 7200 units/day
      const gmt3 = new Date(Date.now() + 3 * 3600 * 1000);
      const startOfDay = new Date(Date.UTC(gmt3.getUTCFullYear(), gmt3.getUTCMonth(), gmt3.getUTCDate()) - 3 * 3600 * 1000);
      const { count } = await supabase.from('error_log')
        .select('id', { count: 'exact', head: true })
        .eq('service', 'youtube-search')
        .like('message', 'cron-run%')
        .gte('created_at', startOfDay.toISOString());
      if ((count ?? 0) >= DAILY_CRON_SEARCHES) {
        return new Response(JSON.stringify({ success: true, skipped: 'daily budget reached', done_today: count }),
          { headers: { ...cors, 'Content-Type': 'application/json' } });
      }
    }

    const allGeos = Object.keys(GEO_QUERY_SETS);
    const geos: string[] = Array.isArray(body.geos) && body.geos.length
      ? body.geos
      : isCron
        ? [ allGeos[Math.floor(Date.now() / (7 * 60 * 1000)) % allGeos.length] ]   // one rotating GEO per tick
        : allGeos;
    const minSubs   = Math.max(0, parseInt(String(body.min_subscribers ?? MIN_SUBS_FLOOR)) || MIN_SUBS_FLOOR);
    const maxPerGeo = Math.min(20, Math.max(1, parseInt(String(body.max_per_geo ?? (isCron ? 8 : 5))) || (isCron ? 8 : 5)));

    // Existing YouTube channel URLs — de-dupe so re-runs don't pile up rows.
    const { data: existing } = await supabase.from('telegram_channels')
      .select('id,url,email,telegram,whatsapp').eq('partner_type', 'youtube').limit(10000);
    const byUrl = new Map<string, any>();
    for (const r of (existing || [])) if (r.url) byUrl.set(r.url.toLowerCase(), r);

    let saved = 0, updated = 0, processed = 0, skippedSubs = 0, skippedStale = 0;
    const perGeo: Record<string, number> = {};

    for (const geo of geos) {
      const q = pickQuery(geo, isCron);
      perGeo[geo] = 0;

     try {
      // 1. Search channels for this GEO.
      // regionCode biases results to the country; no language bias — several of our
      // GEOs are francophone/Portuguese, so forcing English would hide local channels.
      let search;
      try {
        search = await ytApi('search', {
          part: 'snippet', type: 'channel', q, maxResults: String(maxPerGeo), regionCode: geo,
        });
      } catch (_) {
        // Bad/unsupported regionCode → retry without it rather than losing the GEO.
        search = await ytApi('search', {
          part: 'snippet', type: 'channel', q, maxResults: String(maxPerGeo),
        });
      }
      const channelIds = (search.items || [])
        .map((it: any) => it?.snippet?.channelId || it?.id?.channelId).filter(Boolean);
      if (!channelIds.length) continue;

      // 2. Channel details (description holds contacts; statistics holds subs;
      //    contentDetails holds the uploads playlist for the recency check).
      const details = await ytApi('channels', {
        part: 'snippet,brandingSettings,statistics,contentDetails', id: channelIds.join(','),
      });

      for (const ch of (details.items || [])) {
        processed++;
        const chId  = ch.id;
        const url   = `https://www.youtube.com/channel/${chId}`;
        const title = ch?.snippet?.title || 'YouTube channel';
        const desc  = (ch?.snippet?.description || '') + '\n'
          + (ch?.brandingSettings?.channel?.description || '');
        const language = ch?.snippet?.defaultLanguage || ch?.brandingSettings?.channel?.defaultLanguage
          || ch?.snippet?.country || null;
        const custom   = ch?.snippet?.customUrl || null;

        // Subscriber floor — hidden-count channels can't be verified, so drop them
        // whenever a floor is set (we want real, sizeable channels only).
        const hidden = !!ch?.statistics?.hiddenSubscriberCount;
        const subs   = hidden ? null : parseInt(ch?.statistics?.subscriberCount || '0') || 0;
        if (minSubs > 0 && (subs === null || subs < minSubs)) { skippedSubs++; continue; }

        // Recency filter — only channels that posted a video within MAX_AGE_DAYS.
        // Uses the channel's uploads playlist (1 quota unit), not a search call.
        const uploads = ch?.contentDetails?.relatedPlaylists?.uploads;
        const lastVideo = await latestVideoDate(uploads);
        if (!lastVideo || (Date.now() - lastVideo.getTime()) > MAX_AGE_DAYS * 86400_000) {
          skippedStale++; continue;
        }

        const contacts = extractContacts(desc);
        const has1xbet = /1xbet|1x bet/i.test(desc);
        const score    = scoreOf(contacts);
        const priority = score >= 70 ? 'High' : score >= 50 ? 'Medium' : 'Low';

        const row = {
          name: title,
          username: custom,
          url,
          description: desc.slice(0, 1000).trim(),
          why_relevant: `YouTube tipster — ${title}`,
          partner_type: 'youtube',
          geo,
          language,
          found_query: q,
          subscribers: subs ?? 0,
          score, priority,
          has_1xbet: has1xbet,
          email:    contacts.email,
          telegram: contacts.telegram,
          whatsapp: contacts.whatsapp,
          links:    contacts.links,
        };

        const prev = byUrl.get(url.toLowerCase());
        if (prev) {
          // Refresh contacts only if we learned something new (don't wipe existing).
          const patch: Record<string, unknown> = {};
          if (!prev.email    && contacts.email)    patch.email    = contacts.email;
          if (!prev.telegram && contacts.telegram) patch.telegram = contacts.telegram;
          if (!prev.whatsapp && contacts.whatsapp) patch.whatsapp = contacts.whatsapp;
          if (Object.keys(patch).length) {
            await supabase.from('telegram_channels').update(patch).eq('id', prev.id);
            updated++;
          }
          continue;
        }

        const { error } = await supabase.from('telegram_channels').insert([row]);
        if (!error) { byUrl.set(url.toLowerCase(), { id: null, url, ...contacts }); saved++; perGeo[geo]++; }
      }
     } catch (geoErr: any) {
       // One GEO failing (quota spike, transient API error) must not sink the rest.
       await supabase.from('error_log').insert([{
         level: 'warning', service: 'youtube-search', message: `geo=${geo}: ${geoErr.message}`,
       }]).catch(() => {});
     }
    }

    await supabase.from('error_log').insert([{
      level: 'info', service: 'youtube-search',
      message: `${isCron ? 'cron-run ' : ''}geos=${geos.join(',')} processed=${processed} saved=${saved} updated=${updated} skipped_subs=${skippedSubs} skipped_stale=${skippedStale} minsubs=${minSubs}`,
    }]);

    return new Response(JSON.stringify({ success: true, saved, updated, processed, skipped_subs: skippedSubs, skipped_stale: skippedStale, min_subs: minSubs, per_geo: perGeo }),
      { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    await supabase.from('error_log').insert([{
      level: 'warning', service: 'youtube-search', message: e.message,
    }]).catch(() => {});
    return new Response(JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
