---
title: Monitoring Stack Degraded
type: troubleshooting
tags: [monitoring, prometheus, grafana, loki, kubernetes]
sources:
  - argocd-apps/monitoring.yaml
  - charts/monitoring/
created: 2026-04-28
updated: 2026-04-28
---

# Monitoring Stack Degraded

> For the systematic 13-step verification procedure, see [Monitoring Stack Health Check](../runbooks/monitoring-stack-health-check.md).
> For Prometheus-specific scrape issues, see [Prometheus Scrape Targets](prometheus-scrape-targets.md).

## Troubleshooting — Common Issues

### Issue 1: PVCs Stuck in Pending

**Symptoms:** Pods show `Pending`, PVCs show `Pending` status.

**Root Cause:** PVCs have no `storageClassName` and no default StorageClass exists.

**Fix:**

```bash
# Option A: Set default StorageClass (cluster-wide)
sudo kubectl patch sc local-path -p \
  '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# Option B: Patch PVCs individually (if already created without a class)
# Note: storageClassName cannot be changed on an existing PVC.
# Delete and recreate the PVC with the correct storageClass.
sudo kubectl delete pvc <PVC_NAME> -n monitoring
# Then let ArgoCD recreate it (or manually apply the template).
```

### Issue 2: Init Container Missing Resources (ResourceQuota Violation)

**Symptoms:** Pods never created, ReplicaSet shows `FailedCreate`.

**Root Cause:** The `monitoring-quota` ResourceQuota requires all containers to specify `resources`, but an init container (e.g., `fix-permissions`) is missing them.

**Fix:** Add `resources` to the init container in the Helm template, commit, and push.

### Issue 3: Tempo Returns 503 on Startup

**Symptoms:** Tempo pod shows `0/1 Running`, readiness/liveness probes fail with 503.

**Root Cause:** Tempo needs ~30 seconds to initialize its ingester ring and WAL replay.

**Fix:** Wait. Tempo will become ready on its own. If it persists beyond 2 minutes, check logs:

```bash
sudo kubectl logs -n monitoring deploy/tempo --tail=50
```

### Issue 4: Grafana Cannot Connect to Datasource

**Symptoms:** Grafana dashboards show "No Data" or datasource errors.

**Root Cause:** Prometheus, Loki, or Tempo Service is unreachable.

**Fix:**

```bash
# Check if endpoints exist for each datasource
sudo kubectl get endpoints prometheus loki tempo -n monitoring

# Test connectivity from Grafana pod
GRAFANA_POD=$(sudo kubectl get pods -n monitoring -l app=grafana \
  -o jsonpath='{.items[0].metadata.name}')
sudo kubectl exec -n monitoring $GRAFANA_POD -- wget -qO- http://prometheus:9090/-/ready 2>&1
sudo kubectl exec -n monitoring $GRAFANA_POD -- wget -qO- http://loki:3100/ready 2>&1
sudo kubectl exec -n monitoring $GRAFANA_POD -- wget -qO- http://tempo:3200/ready 2>&1
```

### Issue 5: Old Pending Pods Still Visible

**Symptoms:** After a fix, old `Pending` pods from a previous ReplicaSet remain.

**Root Cause:** Kubernetes created a new ReplicaSet for the updated config, but the old one still has `DESIRED > 0`.

**Fix:**

```bash
# Rollout restart cleans up old pods
sudo kubectl rollout restart deployment <DEPLOYMENT_NAME> -n monitoring
```

### Issue 6: Prometheus Targets Down

**Symptoms:** `up` query returns `0` for some targets.

**Root Cause:** Usually a NetworkPolicy or cross-node networking issue.

**Fix:**

```bash
# Check which targets are down
sudo kubectl exec -n monitoring deploy/prometheus -- \
  wget -qO- http://localhost:9090/api/v1/targets 2>&1 \
  | python3 -m json.tool | grep -B2 '"health": "down"'

# Verify cross-node networking
# See: cross-node-networking-troubleshooting.md
```

### Issue 7: ArgoCD Shows "Unknown" Sync Status — Helm Template Rendering Error

**Symptoms:** ArgoCD UI shows the monitoring application as `Sync: Unknown`, `Health: Degraded`.
All resources within the application appear as `Unknown`. Running `kubectl get application`
confirms the status:

```bash
sudo kubectl get application monitoring -n argocd \
  -o jsonpath='{.status.sync.status}{" "}{.status.health.status}'
```

Output: `Unknown Degraded`

**Root Cause:** Broken Helm template delimiters in one or more chart templates.
For example, `{{ .Values.foo }}` was corrupted to `{ { .Values.foo } }` (spaces inside braces).
This prevents Helm from parsing **any** template in the chart, so ArgoCD cannot render any
resources, resulting in `Unknown` sync status for all resources — not just the broken file.

**Diagnose (via SSM session on control plane):**

```bash
# 1. Attempt to render the chart locally — Helm will show the parse error
sudo helm template monitoring-stack \
  /data/app-deploy/monitoring/chart \
  -f /data/app-deploy/monitoring/chart/values-development.yaml

# 2. Check ArgoCD application conditions for error messages
sudo kubectl get application monitoring -n argocd \
  -o jsonpath='{.status.conditions[*].message}'

# 3. Check ArgoCD repo-server logs for rendering errors
sudo kubectl logs -n argocd -l app.kubernetes.io/name=argocd-repo-server \
  --tail=50 | grep -i "error\|fail"
```

**Fix:**

```bash
# Fix broken delimiters in the affected template (example for loki-deployment.yaml)
sudo sed -i 's/{ { /{{/g; s/ } /}}/g' \
  /path/to/chart/templates/loki-deployment.yaml

# Verify the fix renders correctly
sudo helm template monitoring-stack /path/to/chart/ \
  -f /path/to/chart/values-development.yaml
```

Then commit and push to Git. ArgoCD will re-sync within ~3 minutes.

> [!IMPORTANT]
> A CI pipeline validation step (`just helm-validate-charts`) was added to the GitOps workflow
> to catch this class of error **before** ArgoCD syncs. See
> `.github/workflows/gitops-k8s-dev.yml` → `Validate Helm Charts` step.

### Issue 8: ArgoCD Application Stuck in Stale State After Fix

**Symptoms:** You've pushed a fix to Git, but ArgoCD still shows the old Degraded/Unknown status.
The ArgoCD UI timestamp shows the last sync was hours ago.

**Root Cause:** ArgoCD caches the rendered manifests. When the chart was broken, ArgoCD cached
the failure state. Even after the fix is pushed, ArgoCD may not automatically re-evaluate
if it considers the application in an error state.

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check the current revision ArgoCD is tracking
sudo kubectl get application monitoring -n argocd \
  -o jsonpath='{.status.sync.revision}'

# 2. Compare with the latest commit on develop
# (From your local machine or CI, not via SSM)
git log -1 --format='%H' origin/develop

# 3. Check ArgoCD sync status details
sudo kubectl get application monitoring -n argocd -o yaml | \
  grep -A5 'sync:'
```

**Fix — Force a Hard Refresh:**

```bash
# Option A: Force a hard refresh via kubectl
sudo kubectl -n argocd patch application monitoring \
  --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# Option B: Delete and let ArgoCD recreate (if app-of-apps manages it)
sudo kubectl delete application monitoring -n argocd
# ArgoCD's app-of-apps root will recreate it from Git within ~3 minutes

# Option C: Restart the ArgoCD application controller (last resort)
sudo kubectl rollout restart deployment argocd-application-controller -n argocd
```

> [!NOTE]
> After a hard refresh, wait 2–3 minutes for ArgoCD to re-render and re-sync the application.
> Monitor progress with:
> ```bash
> sudo kubectl get application monitoring -n argocd -w
> ```

### Issue 9: Loki PVC Stuck in Pending

**Symptoms:** Loki pod is `Pending`, and the `loki-data` PVC shows `Pending` while other
PVCs (grafana-data, prometheus-data, tempo-data) are `Bound`.

```bash
sudo kubectl get pvc -n monitoring
```

Output shows `loki-data` as `Pending` with no volume assigned.

**Root Cause:** The `local-path-provisioner` uses `WaitForFirstConsumer` volume binding mode.
If the Loki pod was previously stuck due to another error (e.g., Issue 7), the PVC may have
been created but never bound because no pod was successfully scheduled to consume it. A stale
PVC can block a fresh deployment.

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check PVC events for binding details
sudo kubectl describe pvc loki-data -n monitoring

# 2. Check if any Loki pods exist
sudo kubectl get pods -l app=loki -n monitoring

# 3. Check local-path-provisioner logs
sudo kubectl logs -n local-path-provisioner \
  -l app=local-path-provisioner --tail=30
```

**Fix — Delete the stale PVC and let ArgoCD recreate it:**

```bash
# 1. Delete any existing Loki pods (if stuck)
sudo kubectl delete pod -l app=loki -n monitoring

# 2. Delete the stale PVC
sudo kubectl delete pvc loki-data -n monitoring

# 3. Force ArgoCD to recreate the PVC
sudo kubectl -n argocd patch application monitoring \
  --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# 4. Verify the PVC is recreated and binds
sudo kubectl get pvc -n monitoring -w
```

> [!CAUTION]
> Deleting a PVC **destroys any data** stored in the corresponding PersistentVolume.
> For Loki, this means all ingested logs are lost. This is acceptable during initial
> deployment but should be avoided in production without a backup strategy.

### Issue 10: Calico CNI Install Fails on Re-Bootstrap (SSM Automation)

**Symptoms:** The SSM Automation bootstrap step `installCalicoCNI` fails with a timeout
or resource conflict error when the cluster is re-bootstrapped on an existing EBS volume.

```text
SSM Bootstrap Steps (Status: Failed)
    [PASS] validateGoldenAMI
    [PASS] initKubeadm
    [FAIL] installCalicoCNI
```

**Root Cause:** On re-bootstrap (when the control plane instance is replaced but the EBS
root volume is retained), Calico's operator and CRDs already exist from the previous
installation. Re-applying `tigera-operator.yaml` causes resource conflicts or timeouts
waiting for resources that are already converging.

**Fix — Idempotency Guard:**

The Calico install step was updated to use a `skip_if` marker file. On re-bootstrap, if
the marker exists, the step is skipped entirely:

```python
# In 03_install_calico.py
CALICO_MARKER = "/etc/kubernetes/.calico-installed"

runner = StepRunner(
    name="install-calico",
    skip_if=CALICO_MARKER,   # ← Skip on re-bootstrap
)
```

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check if the Calico marker exists (indicates prior install)
ls -la /etc/kubernetes/.calico-installed

# 2. Check Calico operator status
sudo kubectl get pods -n tigera-operator
sudo kubectl get tigerastatus

# 3. Check if Calico networking is functional
sudo kubectl get pods -n calico-system
sudo kubectl get nodes -o wide  # All nodes should be Ready
```

**Manual Recovery (if Calico is partially installed):**

```bash
# 1. Force re-apply the operator with server-side apply
sudo kubectl apply --server-side --force-conflicts \
  -f /opt/calico/tigera-operator.yaml

# 2. Apply the Calico installation resource
sudo kubectl apply -f /opt/calico/custom-resources.yaml

# 3. Wait for Calico to converge
sudo kubectl rollout status daemonset/calico-node -n calico-system \
  --timeout=120s

# 4. Create the marker to prevent future conflicts
sudo touch /etc/kubernetes/.calico-installed
```

### Issue 11: Loki CrashLoopBackOff After Removing Root Init Container

**Symptoms:** After removing the `fix-permissions` init container (see Issue 7), Loki enters
`CrashLoopBackOff` with exit code 1. The container repeatedly restarts.

```text
back-off 2m40s restarting failed container=loki
pod=loki-6d78d44d94-qbcx6_monitoring
```

**Root Cause:** The old PVC data directory was written by a root-owned process (the now-removed
init container). While `fsGroup: 10001` sets group ownership on **new** volume mounts,
it does not recursively `chown` existing files. Loki (running as UID 10001) cannot write
to directories still owned by root.

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check Loki logs to confirm the permissions error
sudo kubectl logs -n monitoring -l app=loki --tail=20
```

**Fix — Delete and recreate the PVC:**

```bash
# 2. Delete the old PVC (it was previously stuck/stale anyway)
sudo kubectl delete pvc loki-data -n monitoring

# 3. Force ArgoCD to recreate everything
sudo kubectl -n argocd patch application monitoring \
  --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'

# 4. Watch for the PVC to rebind and pod to recover
sudo kubectl get pvc -n monitoring -w
```

> [!CAUTION]
> Deleting a PVC destroys all stored data. For Loki this means ingested logs are lost.
> A fresh PVC with `fsGroup: 10001` will have correct ownership from the start.

### Issue 12: Loki Still Crashing After ConfigMap Fix — Pod Not Restarted

**Symptoms:** After committing a fix to `loki-configmap.yaml`
(e.g. adding `delete_request_store: filesystem`), ArgoCD shows
`Sync=Synced` but `Health=Degraded`. Loki remains in
`CrashLoopBackOff` with the **old** config error.

**Root Cause:** ConfigMap changes don't automatically restart pods.
ArgoCD applied the updated `loki-configmap.yaml`, but the Loki
pod is still running with the old config cached in memory.
Kubernetes mounts ConfigMaps as volumes at pod startup — changing
a ConfigMap doesn't trigger a rollout.

**Fix (via SSM session on control plane):**

```bash
# Restart the Loki deployment to pick up the new ConfigMap
sudo kubectl rollout restart deployment/loki -n monitoring

# Watch it recover
sudo kubectl get pods -n monitoring -l app=loki -w
```

This creates a new pod that mounts the updated ConfigMap.

> [!TIP]
> A common pattern to automate ConfigMap-triggered restarts is
> adding a checksum annotation to the Deployment pod template:
> `checksum/config: {{ include (print $.Template.BasePath
> "/loki-configmap.yaml") . | sha256sum }}`
> This forces a rollout whenever the ConfigMap content changes.

### Issue 13: New Loki Pod Stuck in Pending After Rollout Restart

**Symptoms:** After `kubectl rollout restart`, the new Loki pod
stays in `Pending` while the old pod remains `Running`:

```text
loki-6d78d44d94-qbcx6   1/1  Running  8 (6m ago)  17m
loki-7d56fd9bd9-w9m7s   0/1  Pending  0           21s
```

**Root Cause:** The `loki-data` PVC uses `local-path` storage
with `ReadWriteOnce` (RWO) access mode, meaning only **one pod
can mount it at a time**. The rolling update strategy creates the
new pod *before* terminating the old one, causing a deadlock —
the new pod can't mount the PVC until the old one releases it.

**Fix (via SSM session on control plane):**

```bash
# Delete the old pod holding the PVC
sudo kubectl delete pod <old-pod-name> -n monitoring

# The new pod should transition to Running
sudo kubectl get pods -n monitoring -l app=loki -w
```

> [!TIP]
> For deployments with RWO volumes, consider setting the
> Deployment strategy to `Recreate` instead of `RollingUpdate`.
> This terminates the old pod before creating the new one,
> avoiding the PVC deadlock entirely.

> [!NOTE]
> **Resolved.** After deleting the old pod, the new Loki pod
> started successfully and the monitoring ArgoCD application
> reached `Synced + Healthy`.

---

### Issue 14: RWO PVC Deadlocks on Rolling Updates — Recreate Strategy Fix

**Symptom:** Pods using RWO (ReadWriteOnce) PersistentVolumeClaims
(Prometheus, Loki, Grafana, Tempo) get stuck in `Pending` or
`CrashLoopBackOff` during rolling updates.

**Root Cause:** The default `RollingUpdate` strategy creates the new
pod before terminating the old one. With RWO volumes, the new pod
cannot mount the PVC while the old pod still holds it.

**Fix:** Set the Deployment strategy to `Recreate` in all four
stateful deployments:

```yaml
spec:
  strategy:
    type: Recreate
```

**Files changed:**
- `prometheus-deployment.yaml`
- `loki-deployment.yaml`
- `grafana-deployment.yaml`
- `tempo-deployment.yaml`

**What this means going forward:** On every config change or image
update, Kubernetes will terminate the old pod first, then create the
new one. Brief downtime (~10–15s) during rollouts, but no more stuck
`Pending` pods or TSDB lock conflicts.

> [!NOTE]
> **Resolved.** All four deployments now use `Recreate` strategy.

---

### Issue 15: Prometheus CrashLoopBackOff — TSDB Lock Conflict

**Symptom:** After a rolling update, the new Prometheus pod starts
successfully but the old pod enters `CrashLoopBackOff` with:

```
Fatal error: opening storage failed: lock DB directory: resource temporarily unavailable
```

**Root Cause:** The new pod acquired the TSDB lock on the
`/prometheus` data directory. The old pod (from the previous
ReplicaSet) keeps trying to start but cannot acquire the lock.

**Diagnosis:**

```bash
# Check pod status
sudo kubectl get pods -n monitoring -l app=prometheus

# Check logs for the crashing pod
sudo kubectl logs <crashing-pod-name> -n monitoring --tail=20
```

**Fix:** Delete the old pod from the previous ReplicaSet:

```bash
sudo kubectl delete pod <old-prometheus-pod-name> -n monitoring
```

**Verify:**

```bash
# Check pods are running
sudo kubectl get pods -n monitoring

# Check service endpoints are populated
sudo kubectl get endpoints grafana prometheus -n monitoring

# Check ArgoCD sync status
sudo kubectl get application monitoring -n argocd
```

> [!TIP]
> This issue is permanently prevented by Issue 14's `Recreate`
> strategy fix. With `Recreate`, the old pod is terminated before
> the new one starts, so no lock conflict occurs.

> [!NOTE]
> ArgoCD may show `Progressing` health status while the old
> crashing pod exists. Deleting it resolves the health check
> and ArgoCD should flip to `Synced + Healthy`.

---

### Issue 16: Traefik IngressRoute Returns 504 — NetworkPolicy Blocks hostNetwork Traffic

**Symptom:** After creating IngressRoutes for Grafana and Prometheus,
`curl http://localhost/grafana` and `curl http://localhost/prometheus`
return `504 Gateway Timeout`.

**Root Cause:** Traefik runs with `hostNetwork: true`, so its traffic
comes from the **node IP**, not a pod IP. The NetworkPolicy's
`namespaceSelector: {}` rules only match pod-to-pod traffic — they
silently block host-network traffic from reaching monitoring services.

**Diagnosis:**

```bash
# Test from inside the cluster (pod-to-pod, bypasses hostNetwork issue)
sudo kubectl run curl-test --rm -it --restart=Never \
  --image=curlimages/curl -- \
  curl -s -o /dev/null -w "%{http_code}" \
  http://grafana.monitoring.svc.cluster.local:3000/api/health
```

If this returns `200`, the NetworkPolicy is blocking Traefik.

**Fix:** Change `namespaceSelector` to `ipBlock: 0.0.0.0/0` for
ports 3000 (Grafana) and 9090 (Prometheus) in `network-policy.yaml`:

```yaml
# Grafana — allow from any IP (including hostNetwork nodes)
- from:
    - ipBlock:
        cidr: 0.0.0.0/0
  ports:
    - port: 3000
      protocol: TCP
# Prometheus — allow from any IP (including hostNetwork nodes)
- from:
    - ipBlock:
        cidr: 0.0.0.0/0
  ports:
    - port: 9090
      protocol: TCP
```

**Verify after ArgoCD syncs:**

```bash
# Wait for sync
sudo kubectl get application monitoring -n argocd -w

# Test endpoints
curl -s -o /dev/null -w "%{http_code}" http://localhost/grafana
curl -s -o /dev/null -w "%{http_code}" http://localhost/prometheus
```

> [!IMPORTANT]
> This pattern applies to **any** service that needs to receive
> traffic from Traefik (or any hostNetwork pod). Standard
> `namespaceSelector` rules will not match — you must use
> `ipBlock` rules instead.

> [!NOTE]
> **Resolved.** After updating the NetworkPolicy, both Grafana
> and Prometheus became accessible via Traefik IngressRoutes.

---

### Issue 17: ArgoCD Sync Fails — Recreate Strategy Rejects Leftover rollingUpdate Settings

**Symptom:** ArgoCD sync fails with:

```
Deployment.apps "grafana" is invalid: spec.strategy.rollingUpdate:
Forbidden: may not be specified when strategy `type` is 'Recreate'
```

This error appears for all four stateful deployments (Grafana,
Loki, Prometheus, Tempo).

**Root Cause:** When Kubernetes has an existing `RollingUpdate`
deployment, adding `type: Recreate` doesn't automatically remove
the `rollingUpdate` settings. Kubernetes rejects the apply because
both `type: Recreate` and `rollingUpdate` config cannot coexist.

**Fix:** Explicitly null out `rollingUpdate` in the deployment
templates:

```yaml
spec:
  strategy:
    type: Recreate
    rollingUpdate: null
```

**Files changed:**
- `prometheus-deployment.yaml`
- `loki-deployment.yaml`
- `grafana-deployment.yaml`
- `tempo-deployment.yaml`

**Workarounds while waiting for ArgoCD sync:**

Scale down the old crashing ReplicaSet directly:

```bash
sudo kubectl scale replicaset <old-replicaset-name> \
  -n monitoring --replicas=0
```

Or force ArgoCD to refresh and re-read Git:

```bash
sudo kubectl -n argocd patch application monitoring \
  --type merge \
  -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'
```

> [!NOTE]
> Scaling down the old ReplicaSet manually may not persist
> because ArgoCD's reconciliation loop (`selfHeal: true`) will
> restore it. The permanent fix requires the `rollingUpdate: null`
> in Git.

**Why `rollingUpdate: null` still failed:**

The monitoring ArgoCD application has auto-sync enabled:

```yaml
syncPolicy:
  automated:
    prune: true
    selfHeal: true
  syncOptions:
    - ServerSideApply=true
```

Despite using `ServerSideApply=true`, the `rollingUpdate: null`
in the Helm-rendered YAML didn't clear the existing `rollingUpdate`
field from the live deployment. Kubernetes still saw both
`type: Recreate` and the leftover `rollingUpdate` config, rejecting
the apply.

**Definitive fix — delete the deployments for a clean CREATE:**

```bash
# Delete all four stateful deployments
sudo kubectl delete deployment grafana loki prometheus tempo \
  -n monitoring

# ArgoCD (selfHeal: true) detects missing resources and
# recreates them via CREATE (not PATCH), avoiding the conflict
sudo kubectl get application monitoring -n argocd -w
sudo kubectl get pods -n monitoring -w
```

This works because a `CREATE` operation builds the resource from
scratch — there is no existing `rollingUpdate` field to conflict
with. ArgoCD auto-sync will detect the missing deployments and
recreate them within ~1 minute.

> [!NOTE]
> **Resolved.** After deleting the four deployments, ArgoCD
> auto-synced and recreated them with the `Recreate` strategy.
> No more `rollingUpdate` conflicts.

---

### Issue 18: github-actions-exporter ImagePullBackOff — Non-Existent Image Tag

**Symptom:** The `github-actions-exporter` pod is stuck in `ImagePullBackOff`
and never starts:

```text
NAME                                       READY   STATUS             RESTARTS   AGE
github-actions-exporter-86cb45dc5d-zt6zw   0/1     ImagePullBackOff   0          34m
```

Pod logs return:

```text
container "github-actions-exporter" is waiting to start:
trying and failing to pull image
```

**Root Cause:** The image tag configured in `values.yaml` pointed to a version
that does not exist on the container registry (GHCR):

```yaml
# values.yaml (BEFORE — v0.7.0 does not exist on ghcr.io)
githubActionsExporter:
  image: ghcr.io/cpanato/github_actions_exporter:v0.7.0
```

The tag `v0.7.0` was either removed from the registry or never published.
Kubernetes repeatedly tries to pull the image and backs off with increasing
delays (`ImagePullBackOff`), but will never succeed because the tag doesn't
exist.

#### Understanding ImagePullBackOff

Kubernetes pulls container images in this sequence:

| Status | Meaning |
| --- | --- |
| `ContainerCreating` | Kubernetes is pulling the image for the first time |
| `ErrImagePull` | The first pull attempt failed (tag not found, auth error, network issue) |
| `ImagePullBackOff` | Kubernetes is waiting before retrying. The backoff delay increases exponentially (10s → 20s → 40s → ... up to 5 minutes) |

To see the exact pull error, use `describe`:

```bash
sudo kubectl describe pod -n monitoring -l app=github-actions-exporter
```

Look for the `Events` section at the bottom. Common errors include:

- `manifest unknown` — the image tag does not exist
- `unauthorized` — authentication is required (private registry)
- `dial tcp: lookup ghcr.io: no such host` — DNS resolution failure

**Diagnose (via SSM session on control plane):**

```bash
# 1. Check the exact error
sudo kubectl describe pod -n monitoring -l app=github-actions-exporter \
  | grep -A10 "Events"

# 2. Check which image the deployment is trying to pull
sudo kubectl get deployment github-actions-exporter -n monitoring \
  -o jsonpath='{.spec.template.spec.containers[0].image}' && echo

# 3. Test if the image can be pulled manually
sudo kubectl run pull-test --rm -it --restart=Never \
  --image=ghcr.io/cpanato/github_actions_exporter:v0.8.0 -- echo "Pull success"
```

**Fix — update the image tag to a valid version:**

```yaml
# values.yaml (AFTER — v0.8.0 exists on ghcr.io)
githubActionsExporter:
  image: ghcr.io/cpanato/github_actions_exporter:v0.8.0
```

**File changed:** `monitoring/chart/values.yaml`

**Verify after ArgoCD syncs:**

```bash
# Wait for ArgoCD to sync the new image tag
sudo kubectl get application monitoring -n argocd -w

# Check if the pod is now running
sudo kubectl get pods -n monitoring -l app=github-actions-exporter

# If the pod is still using the old image, force a rollout
sudo kubectl rollout restart deployment github-actions-exporter -n monitoring
```

#### What Success Looks Like

```text
NAME                                       READY   STATUS    RESTARTS   AGE
github-actions-exporter-5f8c9d7b6a-k2m4j   1/1     Running   0          45s
```

> [!TIP]
> To check available tags for a GHCR image, visit the GitHub
> Packages page for the repository. For this exporter:
> `https://github.com/cpanato/github_actions_exporter/pkgs/container/github_actions_exporter`

> [!NOTE]
> **Resolved.** Updated the image tag from `v0.7.0` to `v0.8.0` in
> `values.yaml`. After ArgoCD synced the change, the pod pulled the
> image successfully and entered `Running` state.

---

## Related

- [Monitoring Stack Health Check](../runbooks/monitoring-stack-health-check.md) — 13-step verification procedure
- [Prometheus Scrape Targets](prometheus-scrape-targets.md) — Prometheus-specific scrape target issues

<!--
Evidence trail (auto-generated):
- Source: docs/incoming/monitoring-troubleshooting-guide.md (migrated 2026-04-28 — split from 1661-line doc; Troubleshooting -- Common Issues section extracted)
- Generated: 2026-04-28
-->
