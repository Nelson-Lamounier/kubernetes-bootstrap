# Grafana `rds-postgres` datasource — hardening

The Ingestion / Background-Jobs / Database dashboards run SQL against RDS through
the `rds-postgres` Grafana datasource. **It currently connects as `postgres` (the
master user)** via `pgbouncer.platform.svc.cluster.local:5432` — so a dashboard-SQL
issue or a compromised Grafana would have full read/write on production data.

## Status

✅ **Applied (DB side):** a dedicated read-only role `grafana_ro` exists with
`SELECT` on the observability tables only. Verified with `has_table_privilege`:
`SELECT` = true, `INSERT`/`DELETE` = false.

```sql
-- already run as the DB owner:
CREATE ROLE grafana_ro NOLOGIN;
GRANT CONNECT ON DATABASE tucaken TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;
GRANT SELECT ON
  prompt_invocations, repository_profiles, repository_profile_embeddings,
  repo_sync_state, document_embeddings, experience_embeddings,
  rag_eval_runs, rag_eval_results, users, user_token_budgets, user_profile_rollup
TO grafana_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM grafana_ro;
```

⏳ **Remaining (credential switch — do this to actually take effect):** the
datasource still authenticates as `postgres`. Point it at `grafana_ro`:

1. Give the role a login + password (strong, random):
   ```sql
   ALTER ROLE grafana_ro WITH LOGIN PASSWORD '<random>';
   ```
2. Store `grafana_ro` / that password in the secret backing the
   `grafana-rds-credentials` ExternalSecret (SSM/Secrets Manager), and set the
   datasource `user` to `grafana_ro` (chart values / datasource provisioning).
   ESO syncs → Grafana reconnects as `grafana_ro`.
3. Verify a dashboard panel still loads, then confirm a write is refused:
   `SET ROLE grafana_ro; INSERT INTO users ... ;  -- must fail: permission denied`.

## Notes
- New dashboard tables: add them to the `GRANT SELECT` list rather than widening
  the role. (System catalogs like `pg_stat_user_indexes` are world-readable — no
  grant needed.)
- Dashboards also `:sqlstring`-quote any user-supplied variable (`$userId`,
  `$repoFullName`, `$user_email`) — SELECT-only role + escaped interpolation =
  defence in depth.
