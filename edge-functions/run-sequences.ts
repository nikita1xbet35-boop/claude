// Supabase Edge Function: run-sequences
// ════════════════════════════════════════════════════════════════════════════
// P0.3 — Follow-up sequence engine. send_queue only ever delivered a single
// touch, while most replies land on the 2nd/3rd. Timings and copy live in the
// sequences / sequence_steps tables, so a cadence change needs no deploy.
//
// Two jobs per run:
//   1. ENROL  — a lead that received its first email but has no sequence yet is
//               put on the active sequence for its brand at step 1, with
//               next_action_at set from step 2's delay.
//   2. ADVANCE— leads whose next_action_at is due get their next step queued,
//               then the cursor moves on. When steps run out the sequence
//               completes.
//
// Stop conditions are checked BEFORE anything is queued: replied, suppressed
// (unsubscribe/hard_no/bounce), bounced, or excluded by scoring. Any of them
// takes the lead out of the sequence permanently.
//
// Idempotent: a step is only queued if no send_queue row already exists for that
// (lead_id, step_no), so a double run cannot double-send.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ENROL_PER_RUN   = 40;
const ADVANCE_PER_RUN = 40;
const WORK_START = 8, WORK_END = 20;   // GMT+3 — follow-ups keep business hours

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

interface Step {
  step_no: number; delay_days: number;
  template_key: string; subject_variant: string | null; body_template: string | null;
}

// Next send slot inside working hours (GMT+3).
function nextSlot(from: Date): Date {
  const d = new Date(from);
  const g = new Date(d.getTime() + 3 * 3600 * 1000);
  const h = g.getUTCHours();
  if (h >= WORK_START && h < WORK_END) return d;
  const bump = new Date(g);
  if (h >= WORK_END) { bump.setUTCDate(bump.getUTCDate() + 1); }
  bump.setUTCHours(WORK_START + Math.floor(Math.random() * 3), Math.floor(Math.random() * 60), 0, 0);
  return new Date(bump.getTime() - 3 * 3600 * 1000);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { enrolled: 0, queued: 0, completed: 0, stopped: 0, skipped: 0, reason: '' };

  try {
    // ── Load active sequences and their steps ────────────────────────────
    const { data: seqs } = await supabase.from('sequences').select('*').eq('active', true);
    if (!seqs?.length) {
      stats.reason = 'no active sequences';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    const { data: allSteps } = await supabase.from('sequence_steps')
      .select('*').in('sequence_id', seqs.map(s => s.id)).order('step_no');

    const stepsBySeq = new Map<number, Step[]>();
    for (const s of allSteps || []) {
      if (!stepsBySeq.has(s.sequence_id)) stepsBySeq.set(s.sequence_id, []);
      stepsBySeq.get(s.sequence_id)!.push(s as Step);
    }
    const seqForBrand = (brand: string) =>
      seqs.find(s => s.brand === brand) || seqs[0];

    const now = new Date();

    // ── 1. Enrol leads that got their first touch but have no sequence ───
    const { data: fresh } = await supabase.from('leads')
      .select('id, brand, contact_email, message_sent_at, replied_at, exclude_reason')
      .is('sequence_id', null)
      .not('message_sent_at', 'is', null)
      .is('replied_at', null)
      .limit(ENROL_PER_RUN);

    for (const lead of fresh || []) {
      if (lead.exclude_reason) { stats.skipped++; continue; }
      const seq = seqForBrand(lead.brand || '1xbet');
      const steps = stepsBySeq.get(seq.id) || [];
      const next = steps.find(s => s.step_no === 2);
      if (!next) { stats.skipped++; continue; }

      const due = new Date(new Date(lead.message_sent_at).getTime() + next.delay_days * 864e5);
      await supabase.from('leads').update({
        sequence_id: seq.id,
        current_step: 1,                        // the original cold email counts as step 1
        next_action_at: nextSlot(due).toISOString(),
        sequence_status: 'active',
      }).eq('id', lead.id);
      stats.enrolled++;
    }

    // ── 2. Advance leads whose next step is due ──────────────────────────
    const { data: due } = await supabase.from('leads')
      .select('id, brand, contact_email, sequence_id, current_step, gmail_account, replied_at, exclude_reason')
      .eq('sequence_status', 'active')
      .not('next_action_at', 'is', null)
      .lte('next_action_at', now.toISOString())
      .limit(ADVANCE_PER_RUN);

    for (const lead of due || []) {
      const email = String(lead.contact_email || '').toLowerCase();

      // ── stop conditions, checked before anything is queued ──
      let stop: string | null = null;
      if (lead.replied_at)     stop = 'replied';
      if (lead.exclude_reason) stop = 'excluded';

      if (!stop && email) {
        const { data: sup } = await supabase.from('suppression_list')
          .select('email').eq('email', email).maybeSingle();
        if (sup) stop = 'suppressed';
      }
      if (!stop && email) {
        const { data: bounced } = await supabase.from('email_log')
          .select('id').ilike('email', email).eq('bounced', true).limit(1).maybeSingle();
        if (bounced) stop = 'bounced';
      }

      if (stop) {
        await supabase.from('leads').update({
          sequence_status: stop === 'replied' ? 'replied' : 'stopped',
          next_action_at: null,
        }).eq('id', lead.id);
        stats.stopped++;
        continue;
      }

      const steps = stepsBySeq.get(lead.sequence_id) || [];
      const nextNo = (lead.current_step || 1) + 1;
      const step = steps.find(s => s.step_no === nextNo);

      if (!step) {
        await supabase.from('leads').update({ sequence_status: 'completed', next_action_at: null }).eq('id', lead.id);
        stats.completed++;
        continue;
      }

      // Never queue the same step twice for the same lead.
      const { data: existing } = await supabase.from('send_queue')
        .select('id').eq('lead_id', lead.id).eq('step_no', nextNo).limit(1).maybeSingle();

      if (!existing) {
        const { error: qErr } = await supabase.from('send_queue').insert([{
          lead_id: lead.id,
          brand: lead.brand || '1xbet',
          gmail_account: lead.gmail_account || 'main',
          scheduled_at: nextSlot(now).toISOString(),
          status: 'pending',
          sequence_id: lead.sequence_id,
          step_no: nextNo,
          variant_key: step.template_key + (step.subject_variant ? '' : ''),
        }]);
        if (qErr) { stats.skipped++; continue; }
        stats.queued++;
      }

      const after = steps.find(s => s.step_no === nextNo + 1);
      await supabase.from('leads').update({
        current_step: nextNo,
        next_action_at: after
          ? nextSlot(new Date(now.getTime() + after.delay_days * 864e5)).toISOString()
          : null,
        sequence_status: after ? 'active' : 'completed',
      }).eq('id', lead.id);
      if (!after) stats.completed++;
    }

    await supabase.from('error_log').insert([{
      level: 'info', service: 'run-sequences',
      message: `enrolled=${stats.enrolled} queued=${stats.queued} completed=${stats.completed} stopped=${stats.stopped} skipped=${stats.skipped}`,
    }]).catch(() => {});

    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ...stats, error: String(e.message || e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
