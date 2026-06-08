# Grafana `rds-postgres` datasource — hardening note

The Ingestion / Background-Jobs dashboards run SQL against RDS through the
`rds-postgres` Grafana datasource (credentials from the `grafana-rds-credentials`
ExternalSecret, interpolated in `chart/templates/grafana/configmap.yaml`).

**Recommendation: the datasource role must be SELECT-only on the observability
tables.** Dashboards only read; a read-write role here turns any dashboard-SQL
issue (or a compromised Grafana) into a write/delete path against production data.

## One-time grant (run as the DB owner)

Replace `<grafana_ro>` with the actual user in `grafana-rds-credentials`:

```sql
-- Dedicated read-only role for Grafana.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM <grafana_ro>;
GRANT USAGE ON SCHEMA public TO <grafana_ro>;

-- Grant SELECT only on the tables the dashboards query.
GRANT SELECT ON
  prompt_invocations,
  repository_profiles,
  repository_profile_embeddings,
  repo_sync_state,
  document_embeddings,
  rag_eval_runs,
  rag_eval_results
TO <grafana_ro>;

-- Belt-and-suspenders: keep new tables from silently becoming readable/writable.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM <grafana_ro>;
```

## Notes
- Grafana panels also use `${var:sqlstring}` interpolation for any user-supplied
  variable (`$userId` / `$repoFullName`) — see the spend panels — so a SELECT-only
  role plus escaped interpolation gives defence in depth.
- If a new dashboard panel needs another table, add it to the `GRANT SELECT` list
  above rather than widening the role.
