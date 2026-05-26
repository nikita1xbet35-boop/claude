// Supabase Edge Function: admin-reset
// Unpauses system, resets failed queue items, and purges geo-excluded leads from queue.
// Called automatically after every deploy.
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

// Same geo blacklist as process-queue and generate-queue
const EXCL_TLDS = ['.co.uk','.org.uk','.me.uk','.com.ua','.org.ua','.com.br','.net.br','.org.br','.com.au','.net.au','.org.au','.co.nz','.com.nz'];
const EXCL_CC   = ['.uk','.ua','.br','.au','.nz','.us'];
const EU_TLDS   = ['.de','.fr','.it','.es','.nl','.be','.at','.ch','.se','.no','.dk','.fi','.pl','.pt','.cz','.hu','.ro','.bg','.hr','.sk','.si','.lt','.lv','.ee','.gr','.ie','.lu','.mt','.cy'];
const GEO_KW    = ['united states','united kingdom','ukraine','brazil','australia','new zealand','usa','u.s.','u.k.','america','germany','france','italy','spain','netherlands','belgium','austria','switzerland','sweden','norway','denmark','finland','poland','portugal','czech','hungary','romania','bulgaria','croatia'];

function isExcluded(url: string, geo?: string): boolean {
  if (geo) { const g = geo.toLowerCase(); if (GEO_KW.some(k => g.includes(k))) return true; }
  if (!url) return false;
  let h = '';
  try { h = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return false; }
  if (EXCL_TLDS.some(t => h.endsWith(t))) return true;
  const tld = '.' + h.split('.').pop()!;
  return EXCL_CC.includes(tld) || EU_TLDS.includes(tld);
}

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

    // 3. Purge geo-excluded leads from queue
    //    Fetch all pending/failed items with their lead URL+geo and skip the bad ones
    const { data: pendingItems } = await supabase
      .from('send_queue')
      .select('id, lead_id')
      .in('status', ['pending', 'failed']);

    let geoPurged = 0;
    if (pendingItems && pendingItems.length > 0) {
      const leadIds = [...new Set(pendingItems.map(p => p.lead_id as string))];
      const { data: leads } = await supabase
        .from('leads').select('id, url, geo').in('id', leadIds);
      const leadMap = new Map((leads || []).map(l => [l.id, l]));

      const excludedQueueIds = pendingItems
        .filter(p => {
          const l = leadMap.get(p.lead_id as string);
          return l && isExcluded(l.url || '', l.geo || '');
        })
        .map(p => p.id);

      if (excludedQueueIds.length > 0) {
        await supabase.from('send_queue')
          .update({ status: 'skipped', error: 'geo excluded (purged by admin-reset)' })
          .in('id', excludedQueueIds);
        // Mark the leads as excluded so generate-queue won't re-add them
        const excludedLeadIds = pendingItems
          .filter(p => excludedQueueIds.includes(p.id))
          .map(p => p.lead_id);
        await supabase.from('leads')
          .update({ stage: 'excluded' })
          .in('id', [...new Set(excludedLeadIds)]);
        geoPurged = excludedQueueIds.length;
      }
    }

    // 4. Reset failed + skipped queue items back to pending (excluding newly geo-skipped)
    const { data: resetData, error: resetErr } = await supabase
      .from('send_queue')
      .update({ status: 'pending', retry_count: 0, error: null })
      .eq('status', 'failed')
      .select('id');
    if (resetErr) throw new Error(`queue reset failed: ${resetErr.message}`);

    const resetCount = resetData?.length ?? 0;

    await supabase.from('error_log').insert([{
      level: 'info',
      service: 'admin-reset',
      message: `System unpaused. Geo-purged ${geoPurged} items. Reset ${resetCount} failed items to pending.`,
    }]);

    return new Response(JSON.stringify({
      success: true,
      system_paused: false,
      geo_purged: geoPurged,
      queue_items_reset: resetCount,
      message: `System active. Purged ${geoPurged} geo-excluded items. Reset ${resetCount} failed items. Sending resumes on next tick.`,
    }), { headers: { ...cors, 'Content-Type': 'application/json' } });

  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
