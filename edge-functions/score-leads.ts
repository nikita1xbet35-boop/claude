// Supabase Edge Function: score-leads
// ════════════════════════════════════════════════════════════════════════════
// P1.1 — Pre-send lead scoring. The queue used to go out in import order; now it
// goes out best-first, and leads we must not touch are removed before sending.
//
// Hard filters run first (score 0 + exclude_reason, never queued):
//   occupied          — our own group's brand/promocode is already on the site,
//                       so another manager owns the relationship
//   competitor_owned  — structurally tied to a competitor (Sporty/SportPesa)
//   partner_territory — Pulse Sports network; our partner's turf
//
// Scoring is deterministic by design. An LLM pass is layered on top only when a
// key is available AND the lead carries free text worth reading — the Groq free
// tier is already the pipeline's bottleneck, so lead prioritisation must not
// depend on it. Every lead gets a usable score either way.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY (+2/3, optional),
//      ANTHROPIC_API_KEY (optional)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const BATCH = 80;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Hard filters ────────────────────────────────────────────────────────────
const OUR_GROUP   = ['1xbet','1x bet','betwinner','melbet','megapari','paripesa','22bet','1xpartners'];
const COMPETITOR_OWNED = ['sportybet','sporty group','sportpesa'];
const PARTNER_TERRITORY = ['pulse sports','pulsesports','pulse.ng','pulse sport'];

// Competitor books we are happy to see — the audience is already betting, just
// not with us, and there is no incumbent manager from our group.
const TARGET_BOOKS = ['bet9ja','betway','premierbet','betclic','1win','betpawa','msport','betano','parimatch','helabet'];

// 1xBet-licensed GEOs (subset relevant to the current Africa focus).
const LICENSED_GEO = new Set(['NG','KE','GH','TZ','UG','CM','CI','SN','BF','ZM','CD','ET','MZ','ML','RW','MW','GN','TG','BJ','NE','GA','CG','CF','TD','SL','LR','GM']);
// Francophone Africa converts better on RevShare per the brief — extra weight.
const FRANCOPHONE = new Set(['CM','CI','SN','BF','CD','ML','NE','TG','BJ','GA','CG','CF','TD','GN']);

function textOf(l: Record<string, any>): string {
  return [l.name, l.url, l.summary, l.description, l.type, l.found_keyword]
    .filter(Boolean).join(' ').toLowerCase();
}

interface Score {
  fit_score: number;
  reasons: string[];
  geo_licensed: boolean;
  vertical: string | null;
  competitor_book: string | null;
  exclude_reason: string | null;
}

function scoreLead(l: Record<string, any>): Score {
  const t = textOf(l);
  const geo = String(l.geo || '').toUpperCase().slice(0, 2);
  const reasons: string[] = [];

  // ── hard filters ──
  for (const b of OUR_GROUP) {
    if (t.includes(b)) {
      return { fit_score: 0, reasons: [`наш бренд на сайте: ${b}`], geo_licensed: LICENSED_GEO.has(geo),
        vertical: null, competitor_book: null, exclude_reason: 'occupied' };
    }
  }
  for (const b of COMPETITOR_OWNED) {
    if (t.includes(b)) {
      return { fit_score: 0, reasons: [`структурно связан с конкурентом: ${b}`], geo_licensed: LICENSED_GEO.has(geo),
        vertical: null, competitor_book: b, exclude_reason: 'competitor_owned' };
    }
  }
  for (const b of PARTNER_TERRITORY) {
    if (t.includes(b)) {
      return { fit_score: 0, reasons: [`территория партнёра: ${b}`], geo_licensed: LICENSED_GEO.has(geo),
        vertical: null, competitor_book: null, exclude_reason: 'partner_territory' };
    }
  }

  // ── scoring ──
  let score = 35;                                  // neutral baseline

  const licensed = LICENSED_GEO.has(geo);
  if (licensed) { score += 18; reasons.push(`GEO в лицензии (${geo})`); }
  else if (geo)  { score -= 8;  reasons.push(`GEO вне лицензии (${geo})`); }

  if (FRANCOPHONE.has(geo)) { score += 12; reasons.push('франкофонная Африка (лучше конвертит на RS)'); }

  // vertical
  let vertical: string | null = null;
  if (/casino|slot|aviator|jackpot/.test(t))                   vertical = 'casino';
  if (/sport|football|betting|odds|prediction|tips|soccer/.test(t)) vertical = vertical ? 'mixed' : 'sport';
  if (!vertical && /finance|crypto|forex/.test(t))             vertical = 'finance';
  if (!vertical && /news|media|blog/.test(t))                  vertical = 'news';
  if (vertical === 'sport' || vertical === 'casino' || vertical === 'mixed') {
    score += 14; reasons.push(`вертикаль: ${vertical}`);
  } else if (vertical) {
    score -= 5; reasons.push(`вертикаль: ${vertical}`);
  }

  // ── v6 qualification signals (set by find-and-queue from the Groq pass) ──
  // These outrank raw content quality: an existing affiliate of a competitor
  // already has traffic, understands revshare, and has someone to talk to.
  const promotes = String(l.competitor_book || '').trim();
  const book = promotes || TARGET_BOOKS.find(b => t.includes(b)) || null;
  if (promotes) {
    score += 25; reasons.push(`действующий аффилиат конкурента: ${promotes}`);
  } else if (book) {
    score += 16; reasons.push(`льёт на конкурента: ${book}`);
  }
  if (l.monetization_signal) {
    score += 15;
    reasons.push('умеет монетизировать трафик' + (l.monetization_evidence ? `: ${String(l.monetization_evidence).slice(0, 60)}` : ''));
  }
  if (l.has_partnership_path) { score += 15; reasons.push('есть путь к B2B-разговору'); }
  if (l.type === 'tipster' || l.type === 'review') { score += 10; reasons.push(`профиль под RevShare: ${l.type}`); }
  if (l.search_layer === 'C') { score += 10; reasons.push('найден по футпринту конкурента (слой C)'); }
  else if (l.search_layer === 'B') { score += 5; reasons.push('медиахолдинг/паблишер (слой B)'); }

  // signals of a real affiliate operation
  if (/affiliate|partner|revshare|rev share|cpa/.test(t)) { score += 8; reasons.push('упоминает партнёрку'); }
  if (l.contact_email_type === 'advertising' || l.contact_email_type === 'admin') {
    score += 6; reasons.push(`контакт: ${l.contact_email_type}`);
  }
  if (l.email_status === 'valid')     { score += 5; reasons.push('email подтверждён'); }
  if (l.email_status === 'catch_all') { score -= 6; reasons.push('catch-all домен'); }

  // noise penalties
  if (/wikipedia|forum|reddit|livescore|flashscore|sofascore/.test(t)) { score -= 25; reasons.push('справочник/агрегатор, не аффилиат'); }

  return {
    fit_score: Math.max(0, Math.min(100, Math.round(score))),
    reasons, geo_licensed: licensed, vertical, competitor_book: book, exclude_reason: null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const stats = { scored: 0, excluded: 0, avg: 0, reason: '' };

  try {
    const { data: leads } = await supabase.from('leads')
      .select('id, name, url, summary, type, geo, brand, found_keyword, contact_email_type, email_status, '
        + 'search_layer, competitor_book, monetization_signal, monetization_evidence, has_partnership_path')
      .is('fit_score', null)
      .limit(BATCH);

    if (!leads?.length) {
      stats.reason = 'nothing to score';
      return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    let total = 0;
    for (const lead of leads) {
      const s = scoreLead(lead);
      await supabase.from('leads').update({
        fit_score: s.fit_score,
        score_reasons: { reasons: s.reasons, scored_at: new Date().toISOString(), engine: 'deterministic' },
        geo_licensed: s.geo_licensed,
        vertical: s.vertical,
        competitor_book: s.competitor_book,
        exclude_reason: s.exclude_reason,
      }).eq('id', lead.id);

      // Excluded leads must not sit in the queue waiting to go out.
      if (s.exclude_reason) {
        await supabase.from('send_queue')
          .update({ status: 'skipped', error: `excluded: ${s.exclude_reason}` })
          .eq('lead_id', lead.id).eq('status', 'pending');
        stats.excluded++;
      }
      stats.scored++;
      total += s.fit_score;
    }
    stats.avg = stats.scored ? Math.round(total / stats.scored) : 0;

    await supabase.from('error_log').insert([{
      level: 'info', service: 'score-leads',
      message: `scored=${stats.scored} excluded=${stats.excluded} avg=${stats.avg}`,
    }]).catch(() => {});

    return new Response(JSON.stringify(stats), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ ...stats, error: String(e.message || e) }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
