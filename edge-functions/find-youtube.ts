// Supabase Edge Function: find-youtube
// New lead source (PREPARED, DISABLED by default). Finds YouTube channels in our
// GEOs (tipsters / cappers / casino content), extracts a business email from the
// channel description / links, and inserts leads with source='youtube' that flow
// through the normal send pipeline.
//
// SAFETY GATE: does nothing unless env YOUTUBE_ENABLED === 'true'. Uses the
// YouTube Data API (env YOUTUBE_API_KEY) — clean and quota-friendly. Without the
// key/flag it is a no-op, so deploying it never changes behaviour.
//
// Deploy: supabase functions deploy find-youtube --no-verify-jwt
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), YOUTUBE_ENABLED, YOUTUBE_API_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ENABLED  = (Deno.env.get('YOUTUBE_ENABLED') || '').toLowerCase() === 'true';
const YT_KEY   = Deno.env.get('YOUTUBE_API_KEY') || '';

const CHANNELS_PER_RUN = 10;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// GEO → localized channel-search queries (tipsters / casino content creators)
const YT_QUERIES: Array<{ geo: string; q: string }> = [
  { geo: 'NG', q: 'betting tips nigeria' },
  { geo: 'KE', q: 'betting tips kenya sportpesa' },
  { geo: 'GH', q: 'betting tips ghana' },
  { geo: 'IN', q: 'cricket betting prediction india' },
  { geo: 'BD', q: 'betting tips bangla' },
  { geo: 'PK', q: 'cricket betting tips pakistan' },
  { geo: 'PH', q: 'sabong pba prediction philippines' },
  { geo: 'BR', q: 'apostas esportivas dicas' },
  { geo: 'AR', q: 'pronosticos deportivos apuestas' },
  { geo: 'CM', q: 'pronostic paris sportif' },
];

const EMAIL_REGEX  = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const EMAIL_IGNORE = ['noreply', 'no-reply', 'example', 'youtube.com', 'sentry', '.png', '.jpg'];
function isValidEmail(e: string): boolean {
  if (!e || e.length > 100) return false;
  const l = e.toLowerCase();
  if (EMAIL_IGNORE.some(ig => l.includes(ig))) return false;
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(e);
}

async function ytApi(path: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ ...params, key: YT_KEY }).toString();
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${qs}`,
    { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`YouTube API ${path} → HTTP ${res.status}`);
  return res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { enabled: ENABLED, processed: 0, saved: 0, no_email: 0, reason: '' };

  if (!ENABLED) {
    stats.reason = 'disabled (YOUTUBE_ENABLED not set)';
    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  if (!YT_KEY) {
    stats.reason = 'no YOUTUBE_API_KEY configured';
    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  try {
    // Rotate query by time so each run hits a different GEO.
    const slot = Math.floor(Date.now() / (30 * 60 * 1000));
    const { geo, q } = YT_QUERIES[slot % YT_QUERIES.length];

    // 1. Search channels
    const search = await ytApi('search', {
      part: 'snippet', type: 'channel', q, maxResults: String(CHANNELS_PER_RUN),
    });
    const channelIds = (search.items || [])
      .map((it: any) => it?.snippet?.channelId || it?.id?.channelId).filter(Boolean);
    if (channelIds.length === 0) {
      stats.reason = 'no channels found';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // 2. Fetch channel details (description often holds a business email)
    const details = await ytApi('channels', {
      part: 'snippet,brandingSettings', id: channelIds.join(','),
    });

    // Existing YouTube leads (dedup by channel URL)
    const { data: existing } = await supabase.from('leads')
      .select('url').eq('source', 'youtube').limit(5000);
    const existingUrls = new Set((existing || []).map((r: any) => (r.url || '').toLowerCase()));

    for (const ch of (details.items || [])) {
      stats.processed++;
      const chId  = ch.id;
      const title = ch?.snippet?.title || 'YouTube channel';
      const desc  = (ch?.snippet?.description || '') + ' '
        + (ch?.brandingSettings?.channel?.description || '');
      const url   = `https://www.youtube.com/channel/${chId}`;
      if (existingUrls.has(url.toLowerCase())) continue;

      const email = [...new Set(desc.match(EMAIL_REGEX) || [])].filter(isValidEmail)[0] || null;
      if (!email) { stats.no_email++; continue; }

      const { error } = await supabase.from('leads').insert([{
        url, name: title, brand: '1xbet', stage: 'new', geo,
        type: 'youtube', score: 60, priority: 'Medium',
        summary: `YouTube channel — ${title}`,
        contact_email: email, contact_email_type: 'advertising', email,
        source: 'youtube',
      }]);
      if (!error) { existingUrls.add(url.toLowerCase()); stats.saved++; }
    }

    await supabase.from('error_log').insert([{
      level: 'info', service: 'find-youtube',
      message: `geo=${geo} q="${q}" processed=${stats.processed} saved=${stats.saved} no_email=${stats.no_email}`,
    }]);

    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    await supabase.from('error_log').insert([{
      level: 'warning', service: 'find-youtube', message: e.message,
    }]);
    return new Response(JSON.stringify({ ...stats, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
