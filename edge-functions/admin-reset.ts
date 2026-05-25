// Supabase Edge Function: admin-reset
// One-shot helper: unpauses the system and resets failed/skipped queue items to pending.
// Call this after fixing Gmail App Passwords in Supabase Secrets.
//
// POST /functions/v1/admin-reset  (no body needed)
// Deploy: supabase functions deploy admin-reset --no-verify-jwt

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    // 1. Un-pause the system
    const { error: pauseErr } = await supabase
      .from('api_usage')
      .update({ system_paused: false })
      .eq('service', 'gmail_main');
    if (pauseErr) throw new Error(`un-pause failed: ${pauseErr.message}`);

    // 2. Switch all LP queue items to main account (LP disabled)
    await supabase
      .from('send_queue')
      .update({ gmail_account: 'main' })
      .eq('gmail_account', 'lp')
      .in('status', ['pending', 'failed', 'skipped']);

    // 3. Reset failed + skipped queue items back to pending
    const { data: resetData, error: resetErr } = await supabase
      .from('send_queue')
      .update({ status: 'pending', retry_count: 0, error: null })
      .in('status', ['failed', 'skipped'])
      .select('id');
    if (resetErr) throw new Error(`queue reset failed: ${resetErr.message}`);

    const resetCount = resetData?.length ?? 0;

    // 4. Log the action
    await supabase.from('error_log').insert([{
      level: 'info',
      service: 'admin-reset',
      message: `System unpaused. LP→main migrated. Reset ${resetCount} failed/skipped items to pending.`,
    }]);

    return new Response(JSON.stringify({
      success: true,
      system_paused: false,
      queue_items_reset: resetCount,
      message: `System is now active. LP→main migrated. ${resetCount} items reset to pending. Sending resumes on next process-queue tick.`,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
