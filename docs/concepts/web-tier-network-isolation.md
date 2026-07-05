---
title: Web-tier network isolation — PSA baseline and VPC-CNI NetworkPolicies
type: concept
tags: [kubernetes, security, network-policy, pod-security-admission, vpc-cni, eks, alb, defence-in-depth]
sources:
  - charts/admin-api/chart/templates/networkpolicy.yaml
  - charts/public-api/chart/templates/networkpolicy.yaml
  - charts/nextjs/chart/templates/network-policy.yaml
  - charts/admin-api/chart/values.yaml
created: 2026-07-05
updated: 2026-07-05
---

# Web-tier network isolation — PSA baseline and VPC-CNI NetworkPolicies

Two admission- and network-layer controls harden the workload namespaces:
Pod Security Admission (PSA) rejects privileged pods at admission, and default-
deny NetworkPolicies constrain which sources may reach each workload. Both were
applied in PR [#211](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/211).
The EKS-specific subtlety — and the reason the policies had previously been
disabled — is how the VPC CNI enforces `ipBlock` rules against ALB traffic.

## Pod Security Admission at baseline, restricted in warn/audit

Each workload namespace is labelled `pod-security.kubernetes.io/enforce:
baseline` with `warn` and `audit` set to `restricted`. For namespaces ArgoCD
creates, the labels are applied through `managedNamespaceMetadata` on the
Application; for the chart-templated namespaces (platform, public-api) they are
set directly on the `Namespace` object. `baseline` blocks privileged
containers, `hostPath`/`hostNetwork`/`hostPID`, and added capabilities at
admission time — every current pod spec passes it, so nothing was rejected on
rollout. `restricted` stays at warn/audit because pods still lacking
`runAsNonRoot`/seccomp would be *rejected* under `enforce: restricted`; that
tightening follows once each namespace's pods carry a compliant
`securityContext`. Verified live on 2026-07-05: **18** namespaces carry the
enforce label. `monitoring` is deliberately excluded — its node-exporter and
promtail DaemonSets legitimately need `hostPath`/`hostPID`.

## Why the NetworkPolicies were off, and why EKS makes them work

The web-tier default-deny NetworkPolicies (nextjs, public-api) had been disabled
during the earlier kubeadm era because Calico did not enforce `ipBlock` rules
for traffic originating from the host network namespace, which silently blocked
kubelet liveness probes. On EKS the VPC CNI network-policy agent enforces
`ipBlock` normally (`--enable-network-policy=true` on the `aws-node`
DaemonSet), so the policies can be re-enabled — the reason they are safe here
but were not on the old cluster.

## The ALB ipBlock rule that keeps live traffic flowing

The internet-facing ALB uses `target-type: ip`, so it connects to pods directly
from ENIs that live in the cluster's public subnets. With the VPC CNI agent
enforcing policy, that path is denied unless explicitly allowed — enabling a
naive default-deny policy would sever `api.nelsonlamounier.com` from the ALB.
The policies therefore admit the public-subnet CIDRs as an `ipBlock` ingress
rule:

```yaml
# charts/public-api/chart/templates/networkpolicy.yaml
ingress:
  - from:
      - ipBlock:
          cidr: 10.0.0.0/24
      - ipBlock:
          cidr: 10.0.1.0/24
    ports:
      - protocol: TCP
        port: 3001
```

Node internal IPs also fall inside those CIDRs, so the same rule admits kubelet
probes. This pattern mirrors the `admin-api` chart's NetworkPolicy, which has
run against the same ALB in production for months
([charts/admin-api/chart/templates/networkpolicy.yaml](../../charts/admin-api/chart/templates/networkpolicy.yaml)).
The remaining ingress rules allow the monitoring namespace (Prometheus scrape)
and, for public-api, the `nextjs-app` namespace (in-cluster BFF calls). Egress
is left unrestricted (`policyTypes: [Ingress]` only) so pods can still reach
RDS, Redis, and AWS APIs.

## Verifying the policy without breaking production

Because these policies gate live public traffic, the safe verification is to
capture the endpoint status before and after: `curl -s -o /dev/null -w
"%{http_code}"` against `https://api.nelsonlamounier.com/healthz` and
`https://nelsonlamounier.com` returned `200` both before and after the policy
was enabled on 2026-07-05, confirming the ALB `ipBlock` rule admits the load
balancer. **7** NetworkPolicies are active cluster-wide.

## Related

- [GitOps security-hardening sweep](../projects/2026-07-security-hardening-sweep.md)
- [Monitoring access control](./monitoring-access-control.md)
  — the ALB + WAF + basic-auth model that fronts the observability namespace

<!--
Evidence trail (auto-generated):
- Source: charts/public-api/chart/templates/networkpolicy.yaml (read 2026-07-05)
- Source: charts/admin-api/chart/templates/networkpolicy.yaml + values.yaml albSourceCidrs (read 2026-07-05)
- Live: kubectl get ds aws-node -n kube-system (enable-network-policy=true, 2026-07-05)
- Live: kubectl get ns -L pod-security.kubernetes.io/enforce (18 namespaces, 2026-07-05)
- Live: kubectl get netpol -A (7 policies, 2026-07-05)
- Live: curl api.nelsonlamounier.com/healthz -> 200 before+after (2026-07-05)
- Git: origin/main PR #211 (9be291d)
-->
