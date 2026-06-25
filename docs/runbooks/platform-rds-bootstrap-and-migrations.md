---
title: Platform RDS bootstrap and DDL migrations
type: runbook
tags: [operations, postgresql, argocd, helm, migrations]
sources:
  - charts/platform-rds/chart/templates/ddl-migrations.yaml
  - charts/platform-rds/chart/templates/bootstrap-job.yaml
created: 2026-06-16
updated: 2026-06-16
---

## When to run this

Use this procedure when you need to:

- Add a new schema change (table, column, index, policy, grant) to the platform
  database.
- Verify that the bootstrap and DDL migration Jobs completed on the last ArgoCD
  sync.
- Diagnose a migration Job that failed or is stuck.

Schema changes ship as idempotent ArgoCD `PostSync` Jobs in
[ddl-migrations.yaml](../../charts/platform-rds/chart/templates/ddl-migrations.yaml).
They re-run on every sync, so this is a Git-driven procedure, not a one-off
manual `psql` session against production.

## Prerequisites

- `kubectl` access to the cluster with read on the `platform` namespace.
- Write access to this repository (migrations are committed, not applied by hand).
- Understanding that PostSync hooks within a single sync-wave run in
  non-deterministic order, so **every migration must be self-contained and
  idempotent** — `CREATE ... IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
  `ON CONFLICT DO NOTHING`, and guarded `DO` blocks for triggers and policies
  ([ddl-migrations.yaml](../../charts/platform-rds/chart/templates/ddl-migrations.yaml#L388-L402)).

## Procedure

### Add a new DDL migration

1. Open [ddl-migrations.yaml](../../charts/platform-rds/chart/templates/ddl-migrations.yaml)
   and copy the most recent `migration-NN-*` Job block.
2. Increment `NN` (two-digit, monotonic) in the Job `name`, the
   `migration:` label, and the comment header. The number determines intended
   apply order; idempotency covers the non-deterministic in-wave ordering.
3. Replace the `psql` heredoc with your SQL. Make every statement idempotent:
   ```sql
   CREATE TABLE IF NOT EXISTS my_table ( ... );
   CREATE INDEX IF NOT EXISTS idx_my_table_col ON my_table (col);
   ALTER TABLE my_table ADD COLUMN IF NOT EXISTS new_col TEXT;
   ```
4. If application roles must read or write the new object, add the grant in the
   same migration so it is co-located with the schema:
   ```sql
   GRANT SELECT, INSERT, UPDATE, DELETE ON my_table TO tucaken_app;
   ```
5. End the heredoc with a status select so the Job logs a clear success line:
   ```sql
   SELECT 'migration-0NN: my_table OK' AS status;
   ```
6. Keep the standard hook annotations on the Job so ArgoCD manages its lifecycle:
   ```yaml
   annotations:
     argocd.argoproj.io/hook: PostSync
     argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
   ```
7. Commit and push. ArgoCD re-runs all migration Jobs on the next sync;
   `BeforeHookCreation` deletes the previous completed Job before recreating it.

### Run the one-shot DynamoDB to Postgres backfill

This is a separate, default-disabled Job, not part of the PostSync stream
([migration-job.yaml](../../charts/platform-rds/chart/templates/migration-job.yaml#L324-L329)):

```bash
helm upgrade platform-rds charts/platform-rds/chart -n platform \
  --set migration.enabled=true \
  --set migration.articlesTable=<dynamo-table> \
  --set migration.strategistTable=<dynamo-table>
kubectl wait --for=condition=complete job/dynamo-to-pg-migration -n platform --timeout=600s
helm upgrade platform-rds charts/platform-rds/chart -n platform --set migration.enabled=false
```

## Verification

1. List the migration and bootstrap Jobs and confirm they completed:
   ```bash
   kubectl get jobs -n platform -l app=platform-rds-migration
   kubectl get jobs -n platform -l app=platform-rds-bootstrap
   ```
2. Read the status line a migration logs on success:
   ```bash
   kubectl logs -n platform job/migration-0NN-<desc>
   # expect: migration-0NN: <desc> OK
   ```
3. Confirm the ArgoCD Application is Synced and Healthy (PostSync hooks are part
   of a healthy sync):
   ```bash
   kubectl get application platform-rds-eks-development -n argocd
   ```
4. Confirm the pooler itself is serving — its readiness probe runs a real
   `SELECT 1` through to RDS:
   ```bash
   kubectl get pods -n platform -l app=pgbouncer
   ```

## Rollback

- **A migration Job fails.** It retries up to `backoffLimit: 3`, then the sync is
  reported degraded. Because every migration is idempotent, the fix is to correct
  the SQL in `ddl-migrations.yaml` and re-sync — not to hand-edit the database.
  Inspect the failure first:
  ```bash
  kubectl describe job migration-0NN-<desc> -n platform
  kubectl logs -n platform job/migration-0NN-<desc>
  ```
- **A migration applied bad schema.** Forward-fix with a new higher-numbered
  migration that corrects it (e.g. `DROP INDEX IF EXISTS` then recreate, as
  migration-007 does). Do not delete or renumber an applied migration — historical
  migrations re-run on every sync, so editing one in place changes what runs
  cluster-wide.
- **The bootstrap image is broken.** Set `bootstrap.enabled: false` in the env
  values file and sync; the chart still renders PgBouncer and RBAC, so existing
  applications keep their database connectivity while the image is fixed
  ([bootstrap-job.yaml](../../charts/platform-rds/chart/templates/bootstrap-job.yaml#L258-L260)).

<!--
Evidence trail (auto-generated):
- Source: charts/platform-rds/chart/templates/ddl-migrations.yaml (read on 2026-06-16)
- Source: charts/platform-rds/chart/templates/bootstrap-job.yaml (read on 2026-06-16)
- Source: charts/platform-rds/chart/templates/migration-job.yaml (read on 2026-06-16)
- Source: argocd-apps/eks/development/platform-rds.yaml (read on 2026-06-16)
-->
