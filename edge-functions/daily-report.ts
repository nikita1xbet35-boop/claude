// Supabase Edge Function: daily-report
// Sends the morning Telegram report at 09:00 GMT+3.
// Aggregates yesterday's activity from api_usage, email_log, leads tables.
// Deploy: supabase functions deploy daily-report
// Env vars needed: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';
const SUPABASE_ANON = Deno.env.get('SUPABASE_ANON_KEY') || '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const now = new Date();

    // Compute yesterday's date range in GMT+3
    const gmt3offset  = 3 * 60 * 60 * 1000;
    const todayGMT3   = new Date(now.getTime() + gmt3offset);
    todayGMT3.setUTCHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayGMT3.getTime() - 24 * 60 * 60 * 1000 - gmt3offset);
    const yesterdayEnd   = new Date(todayGMT3.getTime() - gmt3offset);

    const dateStr = todayGMT3.toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', timeZone: 'Europe/Moscow'
    });

    // ── Fetch data ──────────────────────────────────────────────────────────────

    // Current API usage counters
    const { data: apis } = await supabase.from('api_usage').select('*');

    // Emails sent yesterday
    const { data: sentEmails } = await supabase
      .from('email_log')
      .select('brand, bounced')
      .gte('sent_at', yesterdayStart.toISOString())
      .lt('sent_at',  yesterdayEnd.toISOString());

    // Leads discovered yesterday
    const { data: newLeads } = await supabase
      .from('leads')
      .select('contact_email, contact_telegram')
      .gte('created_at', yesterdayStart.toISOString())
      .lt('created_at',  yesterdayEnd.toISOString());

    // Full pipeline stage distribution
    const { data: pipeline } = await supabase.from('leads').select('stage');

    // ── Aggregate ───────────────────────────────────────────────────────────────

    const totalSent   = sentEmails?.length || 0;
    const bounces     = sentEmails?.filter(e => e.bounced).length || 0;
    const bounceRate  = totalSent > 0 ? ((bounces / totalSent) * 100).toFixed(1) : '0';

    const sentBy1xbet  = sentEmails?.filter(e => e.brand === '1xbet').length     || 0;
    const sentByCasino = sentEmails?.filter(e => e.brand === '1xcasino').length  || 0;
    const sentByLP     = sentEmails?.filter(e => e.brand === 'luckypari').length || 0;

    const leadsFound       = newLeads?.length || 0;
    const leadsWithContact = newLeads?.filter(l => l.contact_email).length || 0;

    const stageCounts: Record<string, number> = {};
    pipeline?.forEach(l => { stageCounts[l.stage] = (stageCounts[l.stage] || 0) + 1; });

    // ── API usage section ───────────────────────────────────────────────────────

    const SERVICE_DISPLAY: Record<string, string> = {
      serpapi:    'SerpAPI',
      groq:       'Groq',
      gmail_main: 'Gmail (main)',
      gmail_lp:   'Gmail (lp)',
      jina:       'Jina',
    };

    const apiLines = (apis || []).map(a => {
      const pct  = Math.round(a.used / a.limit_value * 100);
      const icon = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '✅';
      const name = SERVICE_DISPLAY[a.service] || a.service;
      return `${icon} ${name}: ${a.used}/${a.limit_value} (${pct}%)`;
    }).join('\n');

    // ── Build message ───────────────────────────────────────────────────────────

    const text = `📊 <b>AffiliateOS Daily Report — ${dateStr}</b>

<b>API Usage (yesterday):</b>
${apiLines}

<b>Activity (yesterday):</b>
🔍 Leads found: ${leadsFound} (with contacts: ${leadsWithContact})
📧 Emails sent: ${totalSent}
   • 1xBet: ${sentBy1xbet}
   • 1xCasino: ${sentByCasino}
   • LuckyPari: ${sentByLP}
↩️ Bounces: ${bounces} (${bounceRate}%)

<b>Pipeline status:</b>
📋 New: ${stageCounts['new']        || 0}
⏳ Waiting: ${stageCounts['waiting']   || 0}
🔄 Followup: ${stageCounts['followup']  || 0}
🔬 Researched: ${stageCounts['researched'] || 0}
✅ Ready: ${stageCounts['ready']      || 0}`;

    // ── Send via send-alert edge function ───────────────────────────────────────

    await fetch(FUNCTIONS_URL + '/send-alert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
        'Authorization': 'Bearer ' + SUPABASE_ANON
      },
      body: JSON.stringify({
        level: 'info',
        service: 'system',
        message: 'daily report',
        custom_text: text
      })
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
});
