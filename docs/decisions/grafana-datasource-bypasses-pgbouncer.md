---
title: Grafana RDS datasource connects as postgres master, not grafana_ro, because grafana_ro fails through PgBouncer
type: decision
tags: [grafana, pgbouncer, postgresql, observability, security, least-privilege]
sources:
  - charts/monitoring/chart/values.yaml
  - charts/monitoring/external-secrets/grafana-rds-credentials.yaml
  - charts/monitoring/DATASOURCE-HARDENING.md
created: 2026-06-16
updated: 2026-06-16
---

## Status

Accepted (interim, with known security debt). Superseded once PgBouncer is
configured to authenticate `grafana_ro` via `userlist` or `auth_query`.

## Context

Grafana's Ingestion, Background-Jobs, and Database dashboards run SQL directly
against RDS through the `rds-postgres` datasource, which connects via
`pgbouncer.platform.svc.cluster.local:5432` — the shared
[Platform RDS data tier](../projects/platform-rds-data-tier.md) pooler. The
datasource originally authenticated as the `postgres` **master** user, so a
malicious dashboard query or a compromised Grafana would have full read/write
on production data
([DATASOURCE-HARDENING.md](../../charts/monitoring/DATASOURCE-HARDENING.md)).

To close that gap, a dedicated read-only role `grafana_ro` was created with
`SELECT`-only on the observability tables (plus `BYPASSRLS` so it can read
across tenants), verified with `has_table_privilege` (SELECT true,
INSERT/DELETE false) and applied DB-side in commit `8a07eb6` (#125). Commit
`5ffd496` (#126) then switched the datasource credential from `postgres` to
`grafana_ro`, pulling the password from
`k8s-development/platform-rds/grafana-ro` via the `grafana-rds-credentials`
ExternalSecret.

The switch broke every database panel. Because the datasource connects through
PgBouncer, and PgBouncer authenticates clients against its own credential list
rather than passing through to Postgres, it did not know the `grafana_ro` role —
the connection failed with **SASL authentication failed** and all DB panels went
dark. Commit `c44a6e4` (#128) reverted the credential back to `postgres`.

## Decision

Keep the Grafana `rds-postgres` datasource authenticating as the `postgres`
master user **through PgBouncer** for now. Retain the `grafana_ro` role and its
`SELECT`/`BYPASSRLS` grants in the database — they are already applied and cost
nothing to leave in place — but do not point the datasource at it until PgBouncer
is taught to authenticate `grafana_ro`
([values.yaml](../../charts/monitoring/chart/values.yaml#L254-L261),
`user: postgres`).

The security debt is recorded explicitly rather than hidden: the chart `values.yaml`
and the `grafana-rds-credentials` ExternalSecret both carry `SECURITY DEBT`
comments stating the datasource is on the master user pending PgBouncer auth
config (added in commit `aa07973`, #130, after a security review flagged the
previously misleading comments)
([grafana-rds-credentials.yaml](../../charts/monitoring/external-secrets/grafana-rds-credentials.yaml)).

## Consequences

- **All database dashboard panels work** — the master user authenticates cleanly
  through PgBouncer, which was the only credential it knew.
- **Standing read/write exposure remains.** A dashboard-SQL injection or a
  compromised Grafana has full write access to production data. This is mitigated,
  not eliminated, by defence in depth: dashboards `:sqlstring`-quote every
  user-supplied template variable (`$userId`, `$repoFullName`, `$user_email`), so
  escaped interpolation narrows the blast radius
  ([DATASOURCE-HARDENING.md](../../charts/monitoring/DATASOURCE-HARDENING.md), Notes).
- **Re-enabling least-privilege is a one-step change once unblocked**: set the
  datasource `user` to `grafana_ro`, repoint the ExternalSecret at the
  `grafana-ro` secret path, and ESO + the configmap checksum annotation roll the
  Grafana pod automatically. The DB-side grants already exist, so no schema work
  is needed.
- **The dependency is now explicit**: hardening the observability datasource is
  blocked on PgBouncer auth configuration, tying this decision to the data-tier
  roadmap rather than leaving it as silent debt.

## Alternatives considered

- **Configure PgBouncer to authenticate `grafana_ro`** (`userlist.txt` or
  `auth_query`). This is the correct long-term fix and the documented unblock
  path, but it was out of scope for the monitoring change and requires editing
  the shared pooler that every cluster consumer depends on — too risky to bundle
  into a dashboard-hardening PR. Deferred.
- **Point Grafana directly at the RDS endpoint, bypassing PgBouncer.** Grafana's
  connection count is low, so it would not strain RDS, and `grafana_ro` would
  authenticate natively. Rejected to keep a single, uniform database ingress —
  every cluster client goes through PgBouncer, and carving out an exception for
  Grafana would fragment the connection model and the credential rotation story.
- **Leave the datasource on `postgres` and do nothing.** Rejected: the DB-side
  `grafana_ro` role is cheap to keep applied and makes the eventual switch a
  one-liner, so the partial hardening is worth retaining even while inactive.

<!--
Evidence trail (auto-generated):
- Source: charts/monitoring/chart/values.yaml (read on 2026-06-16, lines 254-261)
- Source: charts/monitoring/external-secrets/grafana-rds-credentials.yaml (read on 2026-06-16)
- Source: charts/monitoring/DATASOURCE-HARDENING.md (read on 2026-06-16)
- Commit: 8a07eb6 (#125) grafana_ro role + grants applied
- Commit: 5ffd496 (#126) switch datasource to grafana_ro
- Commit: c44a6e4 (#128) revert — grafana_ro fails via pgbouncer (SASL auth failed)
- Commit: aa07973 (#130) security-debt comments corrected
-->
