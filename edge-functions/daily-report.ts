// Supabase Edge Function: daily-report
// Sends morning Telegram report at 10:00 MSK (07:00 UTC).
// Shows yesterday's results + current pipeline state ("starting work").
// Deploy: supabase functions deploy daily-report

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const now = new Date();

    const gmt3offset   = 3 * 60 * 60 * 1000;
    const todayGMT3    = new Date(now.getTime() + gmt3offset);
    todayGMT3.setUTCHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayGMT3.getTime() - 24 * 60 * 60 * 1000 - gmt3offset);
    const yesterdayEnd   = new Date(todayGMT3.getTime() - gmt3offset);

    const dateStr = todayGMT3.toLocaleDateString('ru-RU', {
      day: 'numeric', month: 'long', timeZone: 'Europe/Moscow',
    });

    // ── Yesterday's data ───────────────────────────────────────────────────────
    const [sentRes, leadsRes, pipelineRes, queueRes, reserveRes] = await Promise.all([
      supabase.from('email_log').select('brand, bounced')
        .gte('sent_at', yesterdayStart.toISOString())
        .lt('sent_at',  yesterdayEnd.toISOString()),

      supabase.from('leads').select('contact_email')
        .gte('created_at', yesterdayStart.toISOString())
        .lt('created_at',  yesterdayEnd.toISOString()),

      supabase.from('leads').select('stage'),

      // Today's queue state (as of morning)
      supabase.from('send_queue').select('status', { count: 'exact', head: false })
        .eq('status', 'pending'),

      // Contactable reserve: leads with email not yet emailed
      supabase.from('leads').select('id', { count: 'exact', head: true })
        .not('contact_email', 'is', null)
        .neq('contact_email', '')
        .in('stage', ['new', 'ready', 'researched', 'followup']),
    ]);

    const sentEmails = sentRes.data || [];
    const newLeads   = leadsRes.data || [];
    const pipeline   = pipelineRes.data || [];

    const totalSent   = sentEmails.length;
    const bounces     = sentEmails.filter(e => e.bounced).length;
    const bounceRate  = totalSent > 0 ? ((bounces / totalSent) * 100).toFixed(1) : '0';
    const leadsFound  = newLeads.length;
    const withContact = newLeads.filter(l => l.contact_email).length;

    const DAILY_GOAL = 200;
    const sentGoalPct = Math.round((totalSent / DAILY_GOAL) * 100);
    const bar = (pct: number) => {
      const filled = Math.floor(Math.min(pct, 100) / 10);
      return '█'.repeat(filled) + '░'.repeat(10 - filled);
    };

    const stageCounts: Record<string, number> = {};
    pipeline.forEach(l => { stageCounts[l.stage] = (stageCounts[l.stage] || 0) + 1; });

    const pendingCount = queueRes.count ?? 0;
    const reserve      = reserveRes.count ?? 0;

    // ── Build message ──────────────────────────────────────────────────────────
    const text = `☀️ <b>AffiliateOS — доброе утро, ${dateStr}</b>

<b>Вчера:</b>
📧 Писем отправлено: <b>${totalSent}</b> / ${DAILY_GOAL} (${sentGoalPct}%)
   ${bar(sentGoalPct)}
🎯 Лидов найдено: ${leadsFound} (с контактом: ${withContact})
↩️ Баунсы: ${bounces} (${bounceRate}%)

<b>Pipeline:</b>
📋 new: ${stageCounts['new'] || 0}  •  ⏳ waiting: ${stageCounts['waiting'] || 0}  •  🔄 followup: ${stageCounts['followup'] || 0}

<b>Приступаю к работе:</b>
📬 В очереди на сегодня: ${pendingCount} писем
🔍 Контактный резерв: ${reserve} лидов`;

    await fetch(FUNCTIONS_URL + '/send-alert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
      },
      body: JSON.stringify({ level: 'info', service: 'system', message: 'daily report', custom_text: text }),
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
