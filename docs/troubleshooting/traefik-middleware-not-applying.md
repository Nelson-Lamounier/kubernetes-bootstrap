---
title: Traefik Middleware Not Applying
type: troubleshooting
tags: [traefik, kubernetes, ingress, middleware, ip-allowlist, basic-auth, rate-limit, argocd, eso, gitops]
sources:
  - charts/monitoring/chart/templates/traefik/ip-allowlist-middleware.yaml
  - charts/monitoring/chart/templates/traefik/basicauth-middleware.yaml
  - charts/monitoring/chart/templates/traefik/rate-limit-middleware.yaml
  - charts/monitoring/chart/templates/traefik/allowlist-patcher.yaml
  - charts/monitoring/chart/templates/prometheus/ingressroute.yaml
  - charts/monitoring/chart/templates/grafana/ingressroute.yaml
  - argocd-apps/monitoring.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Traefik Middleware Not Applying

Diagnosis and resolution for middleware chains that do not behave as expected — covering the empty-allowlist window, allowlist-patcher failures, `adminAccess.enabled` gate, ESO credential delays, namespace cross-reference errors, and ArgoCD selfHeal reverting the patched sourceRange.

## Middleware inventory for monitoring stack

Three middlewares are rendered by the monitoring chart
([`charts/monitoring/chart/templates/traefik/`](../../charts/monitoring/chart/templates/traefik/)):

| Middleware | Kind | Key config |
|-----------|------|------------|
| `admin-ip-allowlist` | `IPAllowList` | `sourceRange: []` at chart render time; patched by PostSync Job |
| `rate-limit` | `RateLimit` | `average: 100`, `burst: 50` (requests per second) |
| `basic-auth` | `BasicAuth` | `secret: prometheus-basic-auth-secret`, `removeHeader: true` |

All three are guarded by `{{- if .Values.adminAccess.enabled }}`. If `adminAccess.enabled: false`, none of these resources exist in the cluster.

IngressRoute middleware stacks per endpoint:

| Endpoint | Middlewares (in order) |
|----------|----------------------|
| Grafana | `admin-ip-allowlist`, `rate-limit` |
| Prometheus | `admin-ip-allowlist`, `rate-limit`, `basic-auth` |

## Scenario 1: 403 on all monitoring routes immediately after first sync

**Symptom:** Every request to Grafana and Prometheus returns HTTP 403, even from known-allowed IPs. The IngressRoute exists and routes correctly when middlewares are removed.

**Cause:** The `admin-ip-allowlist` Middleware is rendered by Helm with `sourceRange: []` (empty array) because live CIDRs cannot be stored in Git. The PostSync allowlist-patcher Job has not yet run, or ran and failed.

Traefik evaluates `sourceRange: []` as "allow no IPs" — every request is blocked.

**Diagnosis:**

```bash
# Check the current sourceRange on the Middleware
kubectl get middleware.traefik.io admin-ip-allowlist -n monitoring -o jsonpath='{.spec.ipAllowList.sourceRange}'
# Healthy: ["1.2.3.4/32","2001:db8::/32"]
# Broken:  []

# Check if the patcher Job ran and succeeded
kubectl get job -n monitoring | grep allowlist-patcher
kubectl describe job monitoring-allowlist-patcher -n monitoring
```

**Resolution:** Trigger a manual ArgoCD sync of the `monitoring` Application. This re-applies the Middleware (resetting `sourceRange: []`), then fires the PostSync Job which patches the correct CIDRs.

```bash
argocd app sync monitoring
```

Wait for the Job to complete (`kubectl get job -n monitoring -w`), then verify the sourceRange is populated.

## Scenario 2: allowlist-patcher Job failed or timed out

**Symptom:** The allowlist-patcher Job exits with error. The monitoring application's PostSync hook shows a failure. `sourceRange` remains `[]`.

The patcher waits up to 150 seconds (30 attempts × 5 seconds) for ESO to populate the `admin-ip-allowlist` Secret
([`charts/monitoring/chart/templates/traefik/allowlist-patcher.yaml`](../../charts/monitoring/chart/templates/traefik/allowlist-patcher.yaml)):

```bash
# From the patcher container script:
# "ERROR: admin-ip-allowlist Secret was not populated by ESO within 150s"
```

**Diagnosis:**

```bash
# Check patcher pod logs
kubectl logs -n monitoring -l platform.engineering/role=allowlist-patcher --tail=50

# Check if the ESO-managed Secret exists
kubectl get secret admin-ip-allowlist -n monitoring
kubectl describe externalsecret admin-ip-allowlist -n monitoring
```

**Resolution — ESO hasn't synced yet:** The `admin-ip-allowlist` ExternalSecret polls SSM every 5 minutes. If the Secret doesn't exist, check its ExternalSecret status:

```bash
kubectl describe externalsecret admin-ip-allowlist -n monitoring
# Look for: SecretSyncedError, ParameterNotFound
```

If the SSM parameters `/k8s/{env}/monitoring/allow-ipv4` and `/k8s/{env}/monitoring/allow-ipv6` exist, force ESO to re-sync:

```bash
kubectl annotate externalsecret admin-ip-allowlist -n monitoring \
  force-sync=$(date +%s) --overwrite
```

Once the Secret exists, re-trigger the patcher by syncing the `monitoring` Application again (`argocd app sync monitoring`).

**Resolution — Empty CIDR values:** The patcher script also fails if both SSM values decode to empty strings:

```bash
# "ERROR: ESO Secret produced no CIDRs (ipv4="" ipv6="")"
```

In this case, the SSM parameters exist but contain empty values. Update them:

```bash
aws ssm put-parameter --name "/k8s/development/monitoring/allow-ipv4" \
  --value "1.2.3.4/32" --type String --overwrite --region eu-west-1
aws ssm put-parameter --name "/k8s/development/monitoring/allow-ipv6" \
  --value "2001:db8::/128" --type String --overwrite --region eu-west-1
```

Then trigger an ArgoCD sync to re-run the patcher.

## Scenario 3: ArgoCD selfHeal reverts the patched sourceRange

**Symptom:** The patcher runs successfully and patches the Middleware. Within minutes, `sourceRange` reverts to `[]`. Monitoring returns 403 again.

**Cause:** ArgoCD's `selfHeal: true` detects the live Middleware diverges from the Git-rendered manifest (which has `sourceRange: []`) and reverts it. The `ignoreDifferences` block and `RespectIgnoreDifferences=true` in
[`argocd-apps/monitoring.yaml`](../../argocd-apps/monitoring.yaml) prevent this — but only if both are present:

```yaml
ignoreDifferences:
  - group: traefik.io
    kind: Middleware
    name: admin-ip-allowlist
    jsonPointers:
      - /spec/ipAllowList/sourceRange
syncOptions:
  - RespectIgnoreDifferences=true   # critical — without this, selfHeal still overwrites
```

**Diagnosis:**

```bash
# Confirm both are present in the monitoring Application
kubectl get application monitoring -n argocd -o jsonpath='{.spec.ignoreDifferences}'
kubectl get application monitoring -n argocd -o jsonpath='{.spec.syncPolicy.syncOptions}'
```

**Resolution:** If `RespectIgnoreDifferences=true` is missing from `syncOptions`, add it and commit. ArgoCD will re-apply the Application definition and stop reverting the patched path.

**Note:** `ignoreDifferences` alone suppresses the Out-of-Sync indicator in the ArgoCD UI but does NOT stop selfHeal from overwriting during sync. Both fields are required together.

## Scenario 4: `adminAccess.enabled: false` — middlewares not created

**Symptom:** All three middlewares (admin-ip-allowlist, rate-limit, basic-auth) are absent from the cluster. IngressRoutes referencing them show a Traefik error: `middleware not found`.

**Cause:** The monitoring chart wraps all three middleware definitions in:

```yaml
{{- if .Values.adminAccess.enabled }}
```

If this value is false (or missing), no Middleware resources are rendered. ArgoCD prunes any that previously existed.

**Diagnosis:**

```bash
kubectl get middlewares.traefik.io -n monitoring
# Should list: admin-ip-allowlist, rate-limit, basic-auth
# If empty: adminAccess.enabled is false

helm get values monitoring --all | grep adminAccess
```

**Resolution:** Set `adminAccess.enabled: true` in `charts/monitoring/chart/values-development.yaml` and sync. The middlewares will be created. The allowlist-patcher PostSync Job will populate `sourceRange` on the next sync.

## Scenario 5: `basic-auth` returns 401 despite correct credentials

**Symptom:** Prometheus returns 401. The credentials that worked previously now fail. `admin-ip-allowlist` is patched correctly (confirmed via `kubectl get middleware`).

**Cause:** The `basic-auth` Middleware references Secret `prometheus-basic-auth-secret`, which is managed by ESO from SSM key `/k8s/{env}/prometheus-basic-auth`. ESO refreshes it every 1 hour. If the SSM value was rotated, the Secret now contains a new htpasswd hash.

**Diagnosis:**

```bash
# Verify the Secret exists and contains data
kubectl get secret prometheus-basic-auth-secret -n monitoring -o jsonpath='{.data.users}' | base64 -d

# Verify ESO is syncing correctly
kubectl describe externalsecret prometheus-basic-auth-secret -n monitoring
```

**Resolution:** If the Secret content changed due to SSM rotation, the new htpasswd hash is the source of truth. Obtain the correct credentials from SSM:

```bash
aws ssm get-parameter --name "/k8s/development/prometheus-basic-auth" \
  --with-decryption --region eu-west-1 --query 'Parameter.Value' --output text
```

The htpasswd hash in SSM contains the encoded password. The `removeHeader: true` on the basicAuth Middleware strips the `Authorization` header before forwarding — this is correct behavior for protecting the backend without exposing credentials to the upstream service.

## Scenario 6: Middleware in wrong namespace (cross-namespace reference)

**Symptom:** An IngressRoute in namespace X references a Middleware by name, but the Middleware was created in namespace Y. Traefik logs show `middleware not found`.

**Context:** All monitoring middlewares — `admin-ip-allowlist`, `rate-limit`, `basic-auth` — are created in the `monitoring` namespace (the chart's `.Values.namespace`). IngressRoutes in other namespaces (e.g. `nextjs`, `admin-api`) cannot reference these by name alone.

Traefik CRD-based middlewares are namespace-scoped. A cross-namespace reference requires the `namespace@kubernetescrd` provider format:

```yaml
middlewares:
  - name: monitoring-admin-ip-allowlist@kubernetescrd
    # format: <namespace>-<name>@kubernetescrd
```

Or the middleware must be recreated in the referencing namespace.

**Diagnosis:**

```bash
# List all middlewares across namespaces
kubectl get middlewares.traefik.io -A

# Check which namespace an IngressRoute references
kubectl get ingressroute <name> -n <namespace> -o yaml | grep middlewares -A5
```

## Quick reference: middleware chain per route

| Route | 200 condition | 403 condition | 401 condition |
|-------|--------------|---------------|---------------|
| Grafana | IP in sourceRange | IP not in sourceRange OR sourceRange=[] | N/A |
| Prometheus | IP in sourceRange AND valid basic-auth | IP not in sourceRange OR sourceRange=[] | IP allowed but credentials wrong |

## Related

- [Traefik tool doc](../tools/traefik.md) — DaemonSet architecture, TLS setup, allowlist-patcher flow, ignoreDifferences pattern
- [ESO ExternalSecret not syncing](eso-external-secret-not-syncing.md) — diagnosing why `admin-ip-allowlist` or `prometheus-basic-auth-secret` may not have synced
- [PostSync patcher pattern](../decisions/postsync-patcher-pattern.md) — why ESO cannot write into Traefik CRD fields directly

<!--
Evidence trail (auto-generated):
- Source: charts/monitoring/chart/templates/traefik/ip-allowlist-middleware.yaml (read 2026-04-28 — sourceRange empty array default, adminAccess.enabled guard)
- Source: charts/monitoring/chart/templates/traefik/basicauth-middleware.yaml (read 2026-04-28 — secret: prometheus-basic-auth-secret, removeHeader: true)
- Source: charts/monitoring/chart/templates/traefik/rate-limit-middleware.yaml (read 2026-04-28 — average: 100, burst: 50)
- Source: charts/monitoring/chart/templates/traefik/allowlist-patcher.yaml (read 2026-04-28 — 30×5s retry loop, 150s timeout, exit 1 on empty CIDR, kubectl patch --type=json /spec/ipAllowList/sourceRange, alpine/k8s:1.31.4, backoffLimit: 5)
- Source: charts/monitoring/chart/templates/prometheus/ingressroute.yaml (read 2026-04-28 — admin-ip-allowlist + rate-limit + basic-auth, websecure, priority 100, tls: {})
- Source: charts/monitoring/chart/templates/grafana/ingressroute.yaml (read 2026-04-28 — admin-ip-allowlist + rate-limit only, no basic-auth)
- Source: argocd-apps/monitoring.yaml (read 2026-04-28 — ignoreDifferences on traefik.io/Middleware/admin-ip-allowlist /spec/ipAllowList/sourceRange, RespectIgnoreDifferences=true, selfHeal: true, comment explaining both required together)
- Generated: 2026-04-28
-->
