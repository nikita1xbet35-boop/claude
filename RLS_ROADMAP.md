# Row Level Security (RLS) Implementation Roadmap

## Current State

- **JWT Infrastructure**: ✅ Complete (in `worker.js` at `mintSupabaseJwt()`)
- **JWT Secret Setup**: ✅ Configured in Cloudflare + documented (in `DEPLOY.md`)
- **Role delivered to the page**: ✅ `GET /__role` → `{"role":"full"|"standard"}`
- **JWT Claims**: ✅ Live (`role: 'authenticated'`, `brand_role: 'full'|'standard'`)
- **Database RLS**: 🟡 Enabled on **`brands` only** (migration 046). Every other
  table is still `DISABLE ROW LEVEL SECURITY`.

### What migration 046 actually enforces

`brands` is the first and so far only table where `brand_role` is read by a policy:

| Caller | Public brands | Hidden brands (Melbet, Coldbet) | Writes |
|---|---|---|---|
| `anon` (no session / `?direct=1`) | read | — | denied loudly (`permission denied`) |
| `authenticated` + `brand_role=standard` | read/write | — | public only |
| `authenticated` + `brand_role=full` | read/write | read/write | all |
| `service_role` (edge functions) | full access — `BYPASSRLS` | | |

Verified against a local PostgreSQL 16 instance before merge, including the
`WITH CHECK` case (standard cannot flip a public brand to `hidden`) and a
repeat run of the migration.

`anon` keeps **SELECT** on public brands on purpose: if JWT minting ever breaks,
the dashboard still renders instead of showing "брендов нет", which would look
like an empty database rather than an access failure. Writes are revoked so that
a broken session fails with a visible error instead of a silent no-op.

## What RLS Infrastructure Already Exists

### Worker JWT Minting (`worker.js:334-352`)

```javascript
async function mintSupabaseJwt(env, brandRole) {
  // Mints HS256-signed JWT with:
  // - role: 'authenticated' (database role)
  // - brand_role: 'full' | 'standard' (custom claim for RLS policies)
  // - exp: Date.now() + 300s (5-minute TTL)
}
```

### How It's Used (`worker.js:676-681`)

```javascript
const sess = await readSession(getCookie(request, COOKIE_NAME), env);
const jwt  = sess ? await mintSupabaseJwt(env, sess.role) : null;
if (jwt) {
  fwd.set('apikey', env.SUPABASE_ANON_KEY || DEFAULT_ANON_KEY);
  fwd.set('Authorization', 'Bearer ' + jwt);
}
```

## When to Enable RLS

**DO NOT enable RLS prematurely.** The system currently works fine without it. RLS should be enabled when:

1. ✅ **Multi-brand enforcement needed** — currently all users see all brands; you want:
   - User A sees only their brand (e.g., 1xBet)
   - User B sees only their brand (e.g., 1xCasino)
   - This requires checking `brand_id` in every query

2. ✅ **Role-based access control** — different users have different permissions:
   - `full` role: can modify data
   - `standard` role: read-only
   - This requires policy checks on INSERT/UPDATE/DELETE

3. ✅ **Security hardening** — prevent accidental data access

## RLS Policy Template

When ready, policies will look like this:

```sql
-- Leads: each user sees only their brand
CREATE POLICY leads_brand_isolation ON public.leads
  USING (brand_id = (auth.jwt() ->> 'brand_id')::uuid)
  WITH CHECK (brand_id = (auth.jwt() ->> 'brand_id')::uuid);

-- Funnel stats: read-only for standard role
CREATE POLICY funnel_stats_standard_read ON public.funnel_stats
  FOR SELECT TO authenticated
  USING (
    brand_id = (auth.jwt() ->> 'brand_id')::uuid
    OR (auth.jwt() ->> 'brand_role') = 'full'
  );

CREATE POLICY funnel_stats_full_write ON public.funnel_stats
  FOR INSERT, UPDATE, DELETE TO authenticated
  USING ((auth.jwt() ->> 'brand_role') = 'full')
  WITH CHECK ((auth.jwt() ->> 'brand_role') = 'full');
```

## Implementation Steps

### Phase 1: Preparation (Before Enabling RLS)

1. ✅ Create JWT infrastructure (done in `worker.js`)
2. ✅ Document JWT secret setup (done in `DEPLOY.md`)
3. **TODO**: Ensure all users have `brand_id` in session
   - Current: only `exp` and `role` are stored in session cookie
   - Need: add `brand_id` to session when user logs in
4. **TODO**: Extend `mintSupabaseJwt()` to include `brand_id` claim
   ```javascript
   // Update JWT payload to include:
   brand_id: sess.brand_id,
   ```

### Phase 2: Policy Implementation

1. Create test migration with sample RLS policies
2. Test with one table (e.g., `leads`)
3. Verify in CI that policies enforce correctly
4. Roll out to all tables
5. Monitor error logs for RLS rejections

### Phase 3: Monitoring

Queries rejected by RLS will return `42501 "permission denied"`. Watch `error_log` for:
- Unexpected 42501 errors
- Policy rejection patterns
- Sessions with wrong `brand_id`

## Testing RLS Without Enabling It

To test RLS policies before enabling them:

```sql
-- Dry run: test policy with explicit role
CREATE POLICY test_policy ON public.leads
  USING (brand_id::text = current_setting('app.brand_id'))
  WITH CHECK (brand_id::text = current_setting('app.brand_id'));

-- In test:
SET app.brand_id = '..uuid..';
SELECT * FROM public.leads; -- should return only matching brand
```

## Fallback (If RLS Breaks Everything)

If enabling RLS causes issues:

1. Disable RLS on all tables:
   ```sql
   ALTER TABLE public.leads DISABLE ROW LEVEL SECURITY;
   -- ... repeat for all tables
   ```
2. Redeploy Worker (will continue to mint JWT but it won't be checked)
3. System returns to current behavior (all users see all data)
4. Fix and retry

## JWT Debug Checklist

If RLS isn't working after implementation:

- [ ] SUPABASE_JWT_SECRET is set correctly in Cloudflare
- [ ] JWT is being sent: check DevTools Network → `/db/rest/v1/` → Headers → Authorization
- [ ] JWT is valid: decode at jwt.io, check expiry and claims
- [ ] Claims match policy: check `brand_id`, `brand_role` in JWT payload
- [ ] RLS is enabled: confirm with `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
- [ ] Policies exist: check `information_schema.table_privileges`

## Performance Notes

RLS policies are checked for **every row**. Keep them simple:

❌ Bad (function call per row):
```sql
USING (get_user_brand() = brand_id)
```

✅ Good (direct claim check):
```sql
USING ((auth.jwt() ->> 'brand_id')::uuid = brand_id)
```

---

For questions about JWT minting, see `worker.js:334-352`.
For deployment setup, see `DEPLOY.md`.
