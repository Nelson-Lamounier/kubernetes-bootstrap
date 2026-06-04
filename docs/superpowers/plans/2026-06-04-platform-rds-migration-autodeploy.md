# platform-rds Migration Auto-Deploy (ArgoCD Image Updater) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make newly-built `platform-rds-bootstrap` migration images deploy to dev automatically — no manual `values-development.yaml` tag bump — by wiring ArgoCD Image Updater to the platform-rds app.

**Architecture:** Add the proven Image Updater annotation block (already used by `public-api`/`tucaken-app`/`nextjs`) to the `platform-rds-eks-development` Application, mapped to the chart's nested `bootstrap.image.*` Helm values. New ECR tag → Image Updater git-writes it to `values-development.yaml` on `main` → ArgoCD auto-sync → PostSync migration hook runs the new image. Then a one-time supervised catch-up (the live tag is ~32 migrations stale and the last sync failed).

**Tech Stack:** ArgoCD + argocd-image-updater (git write-back via `argocd/argocd-image-updater-writeback-key`), Helm, kubectl, ECR. Repo **kubernetes-bootstrap is `main`-based** (main is 151 ahead of develop; ArgoCD syncs `main`). Work on branch `feat/platform-rds-image-updater` (off `main`), PR base `main`.

**Spec:** `docs/superpowers/specs/2026-06-04-platform-rds-migration-autodeploy-design.md`

---

## File Structure

**Modify (kubernetes-bootstrap):**
- `argocd-apps/eks/development/platform-rds.yaml` — add the Image Updater annotation block under `metadata.annotations`.
- `charts/platform-rds/chart/values-development.yaml` — replace the "manual until Image Updater wired" comment with an "auto-managed; do not hand-edit" note (the `tag:` value becomes Image-Updater-managed).

**Operational (no file change):**
- Supervised first catch-up + validation against dev RDS.

**Contingency (ai-applications, only if a migration halts):**
- `applications/platform-rds-bootstrap/migrations/<NNN>_*.sql` — make the offending migration idempotent.

---

## Task 1: Add Image Updater annotations to the platform-rds dev app

**Files:**
- Modify: `argocd-apps/eks/development/platform-rds.yaml`

- [ ] **Step 1: Add the annotation block**

In `metadata.annotations` (which currently holds `argocd.argoproj.io/sync-wave: "7"` and `kubernetes.io/description`), add the following keys (mirrors `argocd-apps/eks/development/public-api.yaml:23-30`, but with the **nested** `bootstrap.image.*` Helm paths and the `platform-rds-bootstrap` alias):

```yaml
    argocd-image-updater.argoproj.io/image-list: platform-rds-bootstrap=771826808455.dkr.ecr.eu-west-1.amazonaws.com/platform-rds-bootstrap
    argocd-image-updater.argoproj.io/platform-rds-bootstrap.allow-tags: regexp:^[0-9a-f]{7,40}(-r[0-9]+)?$
    argocd-image-updater.argoproj.io/platform-rds-bootstrap.update-strategy: newest-build
    argocd-image-updater.argoproj.io/platform-rds-bootstrap.helm.image-name: bootstrap.image.repository
    argocd-image-updater.argoproj.io/platform-rds-bootstrap.helm.image-tag: bootstrap.image.tag
    argocd-image-updater.argoproj.io/write-back-method: git:secret:argocd/argocd-image-updater-writeback-key
    argocd-image-updater.argoproj.io/git-branch: main
    argocd-image-updater.argoproj.io/git-repository: git@github.com:Nelson-Lamounier/kubernetes-bootstrap.git
```

Preserve the existing `sync-wave` and `description` annotations; just add these alongside them. Keep 4-space indentation under `annotations:` to match the file.

- [ ] **Step 2: Verify YAML validity + the alias/path mapping**

Run (from the worktree root):
```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('argocd-apps/eks/development/platform-rds.yaml')); a=d['metadata']['annotations']; \
print('image-list:', a['argocd-image-updater.argoproj.io/image-list']); \
print('helm.image-tag:', a['argocd-image-updater.argoproj.io/platform-rds-bootstrap.helm.image-tag']); \
print('write-back:', a['argocd-image-updater.argoproj.io/write-back-method']); \
assert a['argocd-image-updater.argoproj.io/platform-rds-bootstrap.helm.image-tag']=='bootstrap.image.tag'; \
assert a['argocd-image-updater.argoproj.io/platform-rds-bootstrap.helm.image-name']=='bootstrap.image.repository'; \
print('OK')"
```
Expected: prints the three values + `OK` (asserts the Helm paths are the **nested** `bootstrap.image.*`, not the top-level `image.*` the other apps use).

- [ ] **Step 3: Diff-check against the precedent app (same keys, only alias/paths differ)**

Run:
```bash
diff <(grep -oE "argocd-image-updater[^:]+" argocd-apps/eks/development/public-api.yaml | sed 's/public-api/ALIAS/') \
     <(grep -oE "argocd-image-updater[^:]+" argocd-apps/eks/development/platform-rds.yaml | sed 's/platform-rds-bootstrap/ALIAS/') || true
```
Expected: the only differences are the helm paths (`image.repository`→`bootstrap.image.repository`, `image.tag`→`bootstrap.image.tag`); all other annotation keys identical. (public-api may omit `git-repository`; that's fine — having it is correct.)

- [ ] **Step 4: Commit**

```bash
git add argocd-apps/eks/development/platform-rds.yaml
git commit -m "feat(platform-rds): wire ArgoCD Image Updater for bootstrap migration image (dev)"
```

---

## Task 2: Update the stale values comment

**Files:**
- Modify: `charts/platform-rds/chart/values-development.yaml`

- [ ] **Step 1: Replace the "manual" comment**

The `bootstrap.image` block currently has a comment ending "...tag kept in sync here manually until ArgoCD Image Updater is wired to this chart." Replace that comment (lines ~16-18, above `repository:`) with:

```yaml
    # ECR image for the DDL bootstrap / migration PostSync hook.
    # AUTO-MANAGED by ArgoCD Image Updater (see argocd-apps/eks/development/platform-rds.yaml).
    # Image Updater git-writes the newest platform-rds-bootstrap tag here on each new
    # ECR push; do NOT hand-edit the tag. (Break-glass manual apply: ai-applications
    # `just db-bootstrap-run`.)
```

Leave the `repository:` and `tag:` lines as-is (Image Updater will overwrite `tag:` on its first run). Do not change the tag value by hand — the supervised catch-up (Task 4) lets Image Updater set it.

- [ ] **Step 2: Verify the chart still templates**

Run:
```bash
helm template platform-rds charts/platform-rds/chart -f charts/platform-rds/chart/values-development.yaml >/dev/null && echo "TEMPLATE OK"
```
Expected: `TEMPLATE OK` (comment-only change; render unaffected). If `helm` isn't installed, instead run the YAML validity check:
`python3 -c "import yaml; yaml.safe_load(open('charts/platform-rds/chart/values-development.yaml')); print('YAML OK')"`

- [ ] **Step 3: Commit**

```bash
git add charts/platform-rds/chart/values-development.yaml
git commit -m "docs(platform-rds): values comment — tag now auto-managed by Image Updater"
```

---

## Task 3: Open the PR (base `main`)

- [ ] **Step 1: Push + PR to main**

```bash
git push -u origin feat/platform-rds-image-updater
gh pr create --base main --head feat/platform-rds-image-updater \
  --title "feat(platform-rds): auto-deploy migrations via ArgoCD Image Updater (dev)" \
  --body "Wires ArgoCD Image Updater to the platform-rds dev app so new platform-rds-bootstrap migration images deploy automatically (no manual values tag bump). Mirrors the public-api/tucaken-app/nextjs Image Updater pattern, mapped to the nested bootstrap.image.* Helm values; git-writeback to main. Live tag is ~32 migrations stale (c0e075f0) — a supervised first catch-up follows on merge. Spec: docs/superpowers/specs/2026-06-04-platform-rds-migration-autodeploy-design.md"
```

- [ ] **Step 2: Confirm CI green + merge** (per project workflow). After merge, ArgoCD picks up the annotation on the next app refresh.

---

## Task 4: Supervised first catch-up + validation (post-merge, dev)

This is the critical operational step — the first auto-bump jumps ~32 migrations and the last sync failed. **Watch it.**

- [ ] **Step 1: Trigger / confirm Image Updater writes the newest tag**

Image Updater polls on its interval. To act now, restart its run or wait one interval, then confirm the writeback landed in git:
```bash
AWS_PROFILE=dev-account kubectl -n argocd logs deploy/argocd-image-updater --tail=100 | grep -iE "platform-rds-bootstrap|write|updated|error" | tail -20
git -C /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap fetch origin main -q
git -C /Users/nelsonlamounier/Desktop/portfolio/kubernetes-bootstrap show origin/main:charts/platform-rds/chart/values-development.yaml | grep -E "tag:"
```
Expected: the `tag:` on `main` is now the newest `<sha>-r<n>` (no longer `c0e075f0…`). If Image Updater can't determine a current version (hook-only image), seed once: manually set `tag:` to the newest ECR tag in a commit to `main` (one-time), which both triggers the sync and gives Image Updater a baseline to track forward.

- [ ] **Step 2: Watch the PostSync migration hook run**

```bash
AWS_PROFILE=dev-account AWS_REGION=eu-west-1 kubectl get pods -n platform -l job.kind=ddl-bootstrap -w
# in another shell, tail the hook logs (the PostSync Job):
AWS_PROFILE=dev-account kubectl logs -n platform -l app=platform-rds-bootstrap --tail=400 -f
```
Expected: the Job pulls the new image and applies migrations in order. Watch for a **halt** (a migration erroring / ledger checksum rejection). Note the failing migration number if any.

- [ ] **Step 3: Validate the migrations landed**

Use the tucaken-smoke MCP (already proven) or psql:
```
# MCP:  smoke_sql  → SELECT count(*) FROM system_design_concerns
# expect: 14
```
Or via psql over the pgbouncer port-forward (creds from k8s secret `platform/platform-rds-credentials`):
```bash
DB tucaken: SELECT count(*) FROM system_design_concerns;   -- expect 14
```
Expected: `14`. This confirms migration 065 (and the whole backlog) applied — and unblocks the System Design coach smoke run.

- [ ] **Step 4: If the hook HALTED on a migration (contingency)**

The halt is in **ai-applications**, not this repo. In `applications/platform-rds-bootstrap/migrations/<NNN>_*.sql`, make the offending statement idempotent (`CREATE … IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, guard `DO $$ … $$`), or correct a changed-historical-migration checksum per the runner's ledger rules. Open a separate ai-applications PR; once merged + the new image builds, Image Updater bumps again and the hook re-runs. Re-validate Step 3. Until green, the break-glass `just db-bootstrap-run` applies the latest image manually.

---

## Self-review notes
- Annotation keys are copied verbatim from the working `public-api`/`tucaken-app` apps; only the alias (`platform-rds-bootstrap`) and the two `helm.image-*` paths (nested under `bootstrap.`) differ — Task 1 Step 3 asserts exactly that.
- No code/tests here; "verification" = YAML validity, helm-template parity, Image Updater writeback, ArgoCD sync, and the `system_design_concerns = 14` DB check.
- The supervised catch-up (Task 4) is mandatory and human-watched because of the 32-migration jump + the prior failed sync — do not fire-and-forget.
- Prod (`platform-rds-production.yaml` / `values-production.yaml`) is intentionally untouched.
