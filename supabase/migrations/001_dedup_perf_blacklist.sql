-- AffiliateOS upgrade: dedup + performance + blacklist improvements

-- 1. Add domain_normalized column (root domain, no www, no path, lowercase)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS domain_normalized TEXT;

-- 2. Populate domain_normalized from existing URL values
UPDATE leads
SET domain_normalized = lower(
  regexp_replace(
    regexp_replace(
      regexp_replace(url, '^https?://', '', 'i'),
      '^www\.', '', 'i'
    ),
    '[/?#].*$', '', 'g'
  )
)
WHERE domain_normalized IS NULL AND url IS NOT NULL;

-- 3. Add extract_attempts counter (auto-blacklist after 3 failed contact extractions)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS extract_attempts INTEGER DEFAULT 0;

-- 4. Add source field (search / youtube / appstore / discord / mention)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'search';

-- 5. Delete duplicates by domain_normalized — keep the "best" record per domain:
--    priority: has email > advanced stage > newest created_at
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

-- 6. Add UNIQUE constraint on domain_normalized (NULLs are allowed — only non-NULL values are unique)
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_domain_normalized_key;
ALTER TABLE leads ADD CONSTRAINT leads_domain_normalized_key UNIQUE (domain_normalized);

-- 7. Add performance indexes
CREATE INDEX IF NOT EXISTS leads_brand_idx       ON leads(brand);
CREATE INDEX IF NOT EXISTS leads_geo_idx         ON leads(geo);
CREATE INDEX IF NOT EXISTS leads_stage_idx       ON leads(stage);
CREATE INDEX IF NOT EXISTS leads_type_idx        ON leads(type);
CREATE INDEX IF NOT EXISTS leads_score_idx       ON leads(score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS leads_domain_norm_idx ON leads(domain_normalized);
CREATE INDEX IF NOT EXISTS leads_created_at_idx  ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS leads_contact_email_idx ON leads(contact_email) WHERE contact_email IS NOT NULL;

-- 8. Add reason + auto_added fields to blacklist if not present
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS auto_added BOOLEAN DEFAULT FALSE;
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS added_at  TIMESTAMPTZ DEFAULT NOW();

-- 9. login_attempts table for rate-limiting (Block 5)
CREATE TABLE IF NOT EXISTS login_attempts (
  id         BIGSERIAL PRIMARY KEY,
  ip         TEXT NOT NULL,
  failed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour')
);
CREATE INDEX IF NOT EXISTS login_attempts_ip_idx ON login_attempts(ip, failed_at DESC);
-- Auto-cleanup: delete old rows (> 24h) to keep table small
CREATE INDEX IF NOT EXISTS login_attempts_expires_idx ON login_attempts(expires_at);
