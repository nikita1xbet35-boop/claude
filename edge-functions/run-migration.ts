// One-time migration runner — call once to apply 001_dedup_perf_blacklist.sql
// Uses Supabase Management API with SUPABASE_ACCESS_TOKEN secret
// Deploy: supabase functions deploy run-migration --no-verify-jwt

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PROJECT_ID     = 'lxsyrserfuighwxuymgb';
const ACCESS_TOKEN   = Deno.env.get('SUPABASE_ACCESS_TOKEN') || '';

const MIGRATION_SQL = `
ALTER TABLE leads ADD COLUMN IF NOT EXISTS domain_normalized TEXT;

UPDATE leads
SET domain_normalized = lower(
  regexp_replace(
    regexp_replace(
      regexp_replace(url, '^https?://', '', 'i'),
      '^www\\.', '', 'i'
    ),
    '[/?#].*$', '', 'g'
  )
)
WHERE domain_normalized IS NULL AND url IS NOT NULL;

ALTER TABLE leads ADD COLUMN IF NOT EXISTS extract_attempts INTEGER DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'search';

DELETE FROM leads
WHERE id IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY domain_normalized
        ORDER BY
          (contact_email IS NOT NULL) DESC,
          CASE stage
            WHEN 'followup'   THEN 5
            WHEN 'waiting'    THEN 4
            WHEN 'researched' THEN 3
            WHEN 'ready'      THEN 2
            WHEN 'new'        THEN 1
            ELSE 0
          END DESC,
          created_at DESC
      ) AS rn
    FROM leads
    WHERE domain_normalized IS NOT NULL
  ) ranked
  WHERE rn > 1
);

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_domain_normalized_key;
ALTER TABLE leads ADD CONSTRAINT leads_domain_normalized_key UNIQUE (domain_normalized);

CREATE INDEX IF NOT EXISTS leads_brand_idx        ON leads(brand);
CREATE INDEX IF NOT EXISTS leads_geo_idx          ON leads(geo);
CREATE INDEX IF NOT EXISTS leads_stage_idx        ON leads(stage);
CREATE INDEX IF NOT EXISTS leads_type_idx         ON leads(type);
CREATE INDEX IF NOT EXISTS leads_score_idx        ON leads(score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS leads_domain_norm_idx  ON leads(domain_normalized);
CREATE INDEX IF NOT EXISTS leads_created_at_idx   ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS leads_contact_email_idx ON leads(contact_email) WHERE contact_email IS NOT NULL;

ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS reason     TEXT;
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS auto_added BOOLEAN DEFAULT FALSE;
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS added_at   TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS login_attempts (
  id         BIGSERIAL PRIMARY KEY,
  ip         TEXT NOT NULL,
  failed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour')
);
CREATE INDEX IF NOT EXISTS login_attempts_ip_idx      ON login_attempts(ip, failed_at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_expires_idx ON login_attempts(expires_at);
`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  if (!ACCESS_TOKEN) {
    return new Response(JSON.stringify({ error: 'SUPABASE_ACCESS_TOKEN not configured' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: MIGRATION_SQL }),
  });

  const data = await res.json().catch(() => ({}));

  return new Response(JSON.stringify({ ok: res.ok, status: res.status, data }), {
    status: res.ok ? 200 : 500,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
});
