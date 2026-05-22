// Supabase Edge Function: cron-search
// Called every 15 min by Cloudflare Worker cron.
// Rotates through GEO groups and calls auto-search with proper parameters
// so the lead pipeline fills up without any human interaction.
//
// Rotation logic: 17 GEOs × 2 per run → full cycle ≈ 2 hours.
// GEO index is derived from UTC time so every deploy resumes rotation naturally.
// Brand alternates run-by-run (1xbet / 1xcasino).
//
// Deploy: supabase functions deploy cron-search

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ALL_GEOS = ['NG', 'KE', 'GH', 'EA', 'SN', 'CI', 'CM', 'FA2',
                  'BD', 'IN', 'UZ', 'KZ', 'TR', 'MENA', 'LATAM', 'KR', 'JP'];
const GEOS_PER_RUN = 2;
const BRANDS: Array<'1xbet' | '1xcasino'> = ['1xbet', '1xcasino'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    // System pause check
    const { data: sysRow } = await supabase
      .from('api_usage').select('system_paused').eq('service', 'gmail_main').single();
    if (sysRow?.system_paused) {
      return new Response(JSON.stringify({ skipped: true, reason: 'system paused' }),
        { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // Deterministic rotation based on current 15-min slot index
    const nowMin  = Math.floor(Date.now() / (15 * 60 * 1000));
    const geoStart = (nowMin * GEOS_PER_RUN) % ALL_GEOS.length;
    const geos = [];
    for (let i = 0; i < GEOS_PER_RUN; i++) {
      geos.push(ALL_GEOS[(geoStart + i) % ALL_GEOS.length]);
    }
    const brand = BRANDS[nowMin % BRANDS.length];

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    };

    let totalSaved = 0;
    let totalFound = 0;
    const errors: string[] = [];

    // Call auto-search for each GEO individually (matches UI behaviour)
    for (const geo of geos) {
      try {
        const res = await fetch(`${FUNCTIONS_URL}/auto-search`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            geos:          [geo],
            max_total:     20,
            limit_per_key: 3,
            brand,
          }),
          signal: AbortSignal.timeout(50_000),
        });
        if (res.ok) {
          const d = await res.json() as Record<string, number>;
          totalFound += d.found ?? 0;
          totalSaved += d.saved ?? 0;
        } else {
          const txt = await res.text();
          errors.push(`${geo}: HTTP ${res.status} — ${txt.slice(0, 120)}`);
        }
      } catch (e: any) {
        errors.push(`${geo}: ${e.message}`);
      }
    }

    await supabase.from('error_log').insert([{
      level: 'info', service: 'cron-search',
      message: `Searched geos=${geos.join(',')} brand=${brand} → found=${totalFound} saved=${totalSaved}${errors.length ? ' | errors: ' + errors.join('; ') : ''}`,
    }]);

    return new Response(JSON.stringify({ geos, brand, found: totalFound, saved: totalSaved, errors }),
      { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    await supabase.from('error_log').insert([{
      level: 'critical', service: 'cron-search', message: e.message,
    }]);
    return new Response(JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
