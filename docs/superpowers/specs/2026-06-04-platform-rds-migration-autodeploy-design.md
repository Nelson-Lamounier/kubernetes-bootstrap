# Auto-deploy platform-rds migrations via ArgoCD Image Updater (design)

**Date:** 2026-06-04
**Status:** Design — pending review
**Repo:** kubernetes-bootstrap
**Scope:** Make new platform-rds-bootstrap migration images deploy to dev automatically (no manual tag bump). Dev now; prod-ready pattern, prod not auto-enabled.

## 1. Problem

The platform-rds DDL/migration runner is an **ArgoCD PostSync hook Job** in `charts/platform-rds/chart/templates/bootstrap-job.yaml`, whose image is
`{{ .Values.bootstrap.image.repository }}:{{ .Values.bootstrap.image.tag }}` — a tag **manually pinned** in `charts/platform-rds/chart/values-development.yaml`.

ai-applications' `deploy-platform-rds-bootstrap` workflow builds + pushes a new
`platform-rds-bootstrap:<sha>-r<n>` image to ECR (and publishes the URI to SSM) on every
migration merge — but **nothing updates the pinned tag in git**. So ArgoCD (auto-sync on,
`selfHeal`, retry 5) sees no git drift, never re-syncs, and the PostSync migration hook never
runs the new image. Net: dev's committed tag is `c0e075f0…` (migration-024 era) while develop is
**~32 migrations ahead** — newly-merged migrations (e.g. `065_system_design_concerns`) never
reach the dev DB. The values comment already states the intended fix: *"manual until ArgoCD
Image Updater is wired to this chart."* This wires it.

## 2. Decisions (locked in brainstorming)

- **Mechanism:** ArgoCD Image Updater with git write-back (the repo's stated intended path; 3
  apps already use it — `public-api`, `tucaken-app`, `nextjs`).
- **Scope:** dev now (`values-development.yaml`); identical pattern documented for prod
  (`values-production.yaml`) but **not** auto-enabled — prod migrations stay manual until
  deliberately turned on.

## 3. Architecture

Add Image Updater annotations to the `platform-rds-eks-development` Application
(`argocd-apps/eks/development/platform-rds.yaml`), mirroring the existing apps' pattern but
mapping the chart's **nested** `bootstrap.image.*` Helm values:

```
argocd-image-updater.argoproj.io/image-list: platform-rds-bootstrap=771826808455.dkr.ecr.eu-west-1.amazonaws.com/platform-rds-bootstrap
argocd-image-updater.argoproj.io/platform-rds-bootstrap.allow-tags: regexp:^[0-9a-f]{7,40}(-r[0-9]+)?$
argocd-image-updater.argoproj.io/platform-rds-bootstrap.update-strategy: newest-build
argocd-image-updater.argoproj.io/platform-rds-bootstrap.helm.image-name: bootstrap.image.repository
argocd-image-updater.argoproj.io/platform-rds-bootstrap.helm.image-tag: bootstrap.image.tag
argocd-image-updater.argoproj.io/write-back-method: git:secret:argocd/argocd-image-updater-writeback-key
argocd-image-updater.argoproj.io/git-branch: main
argocd-image-updater.argoproj.io/git-repository: git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git
```

(`git-branch: main` is correct — **confirmed**: the platform-rds app's `targetRevision` is `main`,
ArgoCD is synced to `main` HEAD (`94e0d18`), and `main` is the live mainline here — it is **151
commits ahead of `develop`**, which is stale in this repo. All work for this change targets `main`
(branch off `main`, PR base `main`), unlike ai-applications which is develop-based. The write-back
branch must equal the synced branch = `main`.)

**Hook-only-image note:** Image Updater's `helm.image-tag` strategy tracks the Helm *parameter*
against the ECR registry (`newest-build`), not a live workload — so the ephemeral PostSync hook is
fine. This is why the param-mapping pattern (already proven by the 3 apps) works here despite the
image only ever appearing on a transient hook Job.

## 4. Data flow (after wiring)

```
ai-applications migration merged
  → deploy-platform-rds-bootstrap workflow → push platform-rds-bootstrap:<sha>-r<n> to ECR
  → ArgoCD Image Updater (polls ECR, newest-build, allow-tags regexp)
  → git write-back: bumps bootstrap.image.tag in values-development.yaml (via writeback key)
  → git change on the synced branch
  → ArgoCD auto-sync (already enabled)
  → PostSync hook Job runs the new image → idempotent migrations apply (incl. 065)
```

No manual tag bump, ever.

## 5. First supervised catch-up (the second issue)

The first wired bump jumps from `c0e075f0` (migration-024 era) to the newest tag — **~32+
migrations at once**. The app's last sync *"completed unsuccessfully (retried 5 times)."* So the
rollout MUST include a **one-time supervised catch-up**:

1. After wiring, let Image Updater bump the tag (or seed it once), triggering a sync.
2. **Watch the PostSync hook Job logs** (`kubectl logs -n platform -l job.kind=ddl-bootstrap` /
   via the eks MCP) as it applies the backlog.
3. If a specific migration **halts** (non-idempotent / ledger checksum), fix its idempotency in
   ai-applications `applications/platform-rds-bootstrap/migrations/`, rebuild, and re-run.
4. Confirm success: `SELECT count(*) FROM system_design_concerns` = 14 (the migration-065 marker)
   — also unblocks the System Design coach smoke run.

Until the catch-up is green, the ai-applications **break-glass on-demand Job**
(`applications/platform-rds-bootstrap/k8s/bootstrap-job.yaml`, `just db-bootstrap-run`) remains
the manual fallback to apply the latest image immediately.

## 6. Error handling

- **Writeback failure** (key/permission) → no bump; status quo (dev stays at current tag). Safe,
  visible in Image Updater logs.
- **Migration hook failure** → ArgoCD app goes Degraded + retries (limit 5); surfaced for fixing.
  The committed tag is whatever last wrote back, so the hook retries the same image until the
  migration is fixed. Break-glass Job is the fallback.
- **No double-apply risk**: migrations are idempotent (`CREATE … IF NOT EXISTS`) + ledgered, so
  the hook running on every sync is safe.

## 7. Testing / validation

- Render check: `helm template` the chart with the annotations present (annotations live on the
  Application, not the chart, so chart render is unchanged) — confirm `bootstrap.image.tag` is a
  plain value Image Updater can write.
- Image Updater dry-run: confirm it detects the newest ECR tag and the write-back target resolves
  (`bootstrap.image.tag`).
- End-to-end: a real migration merge (or a manual ECR push) → tag written back → sync → hook runs
  → `system_design_concerns` exists with 14 rows.

## 8. Components to change (kubernetes-bootstrap)

- `argocd-apps/eks/development/platform-rds.yaml` — add the Image Updater annotation block.
- `charts/platform-rds/chart/values-development.yaml` — update the stale comment ("manual until
  Image Updater wired" → "auto-managed by Image Updater; do not edit by hand"). The `tag:` value
  becomes Image-Updater-managed.
- `docs/superpowers/...` — this spec + the impl plan.

## 9. Out of scope / follow-ups

- **Prod** (`platform-rds-production.yaml` + `values-production.yaml`): same annotation block,
  enabled deliberately later. Not in this change.
- Fixing any specific non-idempotent migration is ai-applications work, surfaced by the catch-up.
- The uncommitted manual tag bump on `feat/bedrock-spend-dashboard` becomes moot once Image
  Updater manages the tag (owner can keep or drop it).
