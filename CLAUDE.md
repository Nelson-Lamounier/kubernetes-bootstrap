# kubernetes-bootstrap — project rules

GitOps repo for the EKS clusters. **`main` is the deployment branch ArgoCD syncs** (it is the
mainline here; `develop` is divergent/stale). Branch off `main`, PR to `main`, delete the branch
(and `git worktree remove` any worktree) after merge.

> **Adding or changing a workload service?** The authoritative architecture + repo-ownership rules
> live in the **`k8s-new-service`** skill — invoke it first. The two rules below are
> learned-the-hard-way invariants that every new service must satisfy.

## Every new service: two non-negotiables

Each of these gaps shipped a **silently-broken** service — it looked deployed but wasn't, or ran
stale config. Both are mandatory for any new workload.

### 1. Put the dev app where the root actually syncs

`eks-root-development` (the dev app-of-apps) syncs **`argocd-apps/eks/development`**, and it is
**NON-recursive**. Therefore:

- A new service's ArgoCD **`Application` MUST live at `argocd-apps/eks/development/<service>.yaml`**
  — directly in that directory, alongside the existing siblings (`admin-api.yaml`,
  `job-strategist.yaml`, `article-pipeline.yaml`, …).
- **Do NOT** place it in the `argocd-apps/` root, in a sub-subdirectory, or as a standalone
  `ApplicationSet` elsewhere. The root won't see it and the service **never deploys** — no app, no
  pod, no error. (This is exactly how `platform-job-watcher` was absent from dev: it lived only as
  an `ApplicationSet` in `argocd-apps/`, which the non-recursive root never applied.)
- **Production:** add the explicit app to `argocd-apps/applications-production.yaml` (or the prod
  app-of-apps path) — prod does not read `eks/development`.
- **Verify after merge — do not assume:**
  ```bash
  kubectl get applications -n argocd | grep <service>     # the app must appear
  kubectl get pods -A | grep <service>                    # the pod must be Running
  ```
  An app you can't see in `get applications` is not deployed.

### 2. `checksum/config` — auto-roll on config change

Any service whose pod **reads a ConfigMap or Secret at startup** (most do — config is loaded once)
MUST stamp a content hash on the **pod template** so a config change rolls the Deployment:

```yaml
spec:
  template:
    metadata:
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
        # add a checksum/secret line similarly if the pod mounts a rendered Secret
```

Without it, editing the ConfigMap — even via an ArgoCD sync — does **nothing** to the running pod
until someone manually `kubectl rollout restart`s it. The config looks applied (ArgoCD is green)
but the process is still on the old values. (This is why `platform-job-watcher` kept running stale
config after its entries changed.)

## Branch workflow

- `main` is the deployment branch; work on a feature branch off `main`, PR to `main`.
- Delete the branch (local **and** remote) and `git worktree remove` any worktree after the PR
  merges. Keep only `main` (+ `develop` if still in use). Periodically `git remote prune origin`.
- Before deleting a branch, confirm nothing is lost: `git rev-list --count <branch> --not --remotes`
  must be `0` (push to a same-named remote branch first if not).

## Commit & PR message style

- Write every commit **body** and **PR description** with the `impact-commits` skill (`~/.claude/skills/impact-commits/SKILL.md`) — invoke it whenever committing or opening a PR. Bodies/descriptions are impact bullets: past-tense action verb + what + verified numbers/metrics + technologies + why it mattered. The subject line stays Conventional Commits.
- **Never invent a metric.** Ground every number in the manifests/Helm values/`kubectl`/ArgoCD/the live cluster; if it cannot be verified, omit the number and keep the bullet qualitative.
- Trivial commits (image tag bump, one-line value change) get a subject line only — no padded body.
- Mechanics (atomic staging, no AI co-authorship trailer) stay governed by the `git-commit` skill. Use both together.

## Grafana dashboard troubleshooting — protocol

When asked about a dashboard, "why does panel X show no data", or to review/fix a dashboard,
**follow this order — do not jump to query theories.** Use the **Grafana MCP** and the
**dev-account** AWS profile; the live Grafana is `https://ops.nelsonlamounier.com/grafana`
(single in-cluster instance, namespace `monitoring`, served under sub-path).

### 1. Inventory first — enumerate every panel before theorising
- `search_dashboards` → `get_dashboard_by_uid` (or read the JSON from
  `charts/monitoring/chart/dashboards/<name>.json`).
- List **every** panel: `id`, **`type`**, `datasource`, title. **A `type: row` panel is a
  section divider with zero queries — it ALWAYS shows "no data" and is not a viz panel.** The
  classic trap: a row header (e.g. "RDS instance health") looks like an empty panel. Identify
  exactly which element the user means and its type **before** anything else.

### 2. Verify what the PANEL DISPLAYS, not just that the server has data
- "Server returns data" (`/api/ds/query`) does **not** mean the panel renders it. Proving the
  datasource is healthy is necessary but **not sufficient** — reconcile against the user's
  actual screen. If data exists server-side but the user sees none, find **which element** shows
  none and **why** (row header? legitimately empty? mode/variable bug? stale browser model?).

### 3. Check each suspect panel by its datasource (this repo's split)
| Panel kind | Datasource | How to verify live |
|---|---|---|
| RDS instance health (CPU, connections, memory, storage, IOPS, latency) | **CloudWatch** `AWS/RDS`, dim `DBInstanceIdentifier=k8s-dev-platform-rds`, region `eu-west-1` | `aws cloudwatch get-metric-statistics --profile dev-account`; or `/api/ds/query` to uid `cloudwatch` |
| PgBouncer pool, app→DB activity | **Prometheus** | `query_prometheus` (uid `prometheus`) |
| In-DB data (pgvector, users, spend) | **Postgres** `rds-postgres` | `/api/ds/query` with `rawSql` |
| RDS PostgreSQL logs | **CloudWatch Logs** `/aws/rds/instance/k8s-dev-platform-rds/postgresql` | `aws logs filter-log-events --profile dev-account` |
- RDS instance metrics are **only** available via CloudWatch (managed service — no node/postgres
  exporter on the host). That is by design, not a bug.

### 4. Classify the "no data" cause before proposing a fix
- **Row header** → not a panel (explain, optionally add a real status stat inside the row).
- **Legitimately empty** → e.g. logs panels filtering for `ERROR/WARNING` when the DB is healthy
  (only `checkpoint` INFO lines), or idle metrics reading a real `0` (IOPS/latency). Not a bug.
- **CloudWatch query model** → must use key **`dimensions`** (not `dimensionFilters`), set
  `region` + `matchExact`; mirror a known-working dashboard (`networking.json`, `lambda-services.json`).
- **Template variable not interpolating** → for a single fixed value, **hardcode it** rather than
  rely on a one-option custom variable (which can leave panels empty if it ever resolves blank).
- **Stale browser model** → the live pod DB is authoritative: copy `grafana.db` from the pod and
  read the stored dashboard to compare with what the browser sends (Query Inspector → request).
- **Plugin/console errors** are usually noise unless **all** dashboards break — if one datasource's
  dashboards (e.g. Prometheus/Cluster & Nodes) render fine, the frontend is not globally broken.

### 5. Deploy + verify (provisioned dashboards)
- Dashboards ship as per-dashboard ConfigMaps mounted at `/var/lib/grafana/dashboards`; the file
  provisioner reloads on change (no pod restart). After merge: confirm ArgoCD synced the commit,
  the ConfigMap updated, and re-query the panel through the live datasource. A browser tab must do
  a **full page reload** (not the Grafana refresh button) to pick up a new dashboard version.
