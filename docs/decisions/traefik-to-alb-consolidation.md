---
title: Consolidate on ALB Ingress and fully decommission Traefik
type: decision
tags: [traefik, alb, ingress, aws-load-balancer-controller, waf, kubernetes, eks, decommission]
sources:
  - charts/monitoring/chart/templates/grafana/ingressroute.yaml
  - charts/monitoring/chart/templates/prometheus/auth-proxy.yaml
  - gitops/arc/webhook-ingressroute.yaml
created: 2026-07-05
updated: 2026-07-05
---

# Consolidate on ALB Ingress and fully decommission Traefik

## Status

Accepted and complete — PRs
[#220](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/220) and
[#222](https://github.com/Nelson-Lamounier/kubernetes-bootstrap/pull/222),
followed by cluster-side CRD removal. Verified 2026-07-05: **0** Traefik CRDs
remain.

## Context

The self-managed kubeadm cluster used Traefik as its ingress controller, with
`IngressRoute` and `Middleware` custom resources for TLS, IP allow-listing,
basic auth, and rate limiting. The migration to EKS moved ingress to the AWS
Load Balancer Controller (ALB `Ingress` objects), but the Traefik custom
resources were left behind in the charts — and, critically, **no Traefik
controller runs on EKS**. Every remaining `IngressRoute` and `Middleware` was
therefore inert: it existed as an object but nothing served or enforced it.

The residue included: the monitoring admin `Middleware`s (`admin-ip-allowlist`,
`basic-auth`, `rate-limit`) and a PostSync `allowlist-patcher` Job that patched
them; disabled push-endpoint `IngressRoute`s for Loki/Pushgateway/mttr-webhook;
the ARC webhook `IngressRoute`
([gitops/arc/webhook-ingressroute.yaml](../../gitops/arc/webhook-ingressroute.yaml));
and 21 orphaned `traefik.io`/`hub.traefik.io` CRDs.

## Decision

Remove all Traefik resources and rely solely on ALB `Ingress` for exposure.
Admin access control, previously the job of the Traefik IP-allowlist Middleware,
is already enforced at the edge by the ALB WAF
(`BlockNonAllowlistedAdminTraffic`) plus per-service auth — see
[Monitoring access control](../concepts/monitoring-access-control.md).

## Consequences

- Ingress is a single, uniform path: `alb.ingress.kubernetes.io/*`-annotated
  `Ingress` objects joined into the `public` ALB group, fronted by WAF. Grafana,
  Prometheus, and the Faro RUM receiver are all exposed this way
  ([grafana ingress](../../charts/monitoring/chart/templates/grafana/ingressroute.yaml),
  which despite its filename renders a `kind: Ingress`).
- Basic auth, which ALB does not perform natively, is handled by small nginx
  reverse-proxy Deployments (for example the Prometheus
  [auth-proxy](../../charts/monitoring/chart/templates/prometheus/auth-proxy.yaml)),
  not Traefik Middlewares.
- The ARC webhook route was safe to delete because modern ARC uses
  listener/long-poll mode (the `*-listener` pods), not GitHub webhooks.
- Several docs described Traefik as live and are now marked retired:
  [tools/traefik.md](../tools/traefik.md),
  [traefik-middleware-not-applying.md](../troubleshooting/traefik-middleware-not-applying.md),
  [postsync-patcher-pattern.md](./postsync-patcher-pattern.md).
- CRDs are not chart-managed, so the 21 Traefik CRDs were removed with `kubectl`
  after confirming zero live custom-resource instances.

## Alternatives considered

- **Re-install a Traefik controller on EKS** — rejected: ALB + WAF already
  cover TLS, routing, allow-listing, and rate limiting, and running a second
  ingress controller adds cost and a parallel security surface.
- **Migrate the push endpoints to ALB instead of retiring them** — the external
  Loki/Pushgateway/mttr write endpoints were external-by-design but had been
  disabled since the migration with no impact; the owner chose to retire rather
  than rebuild them.

<!--
Evidence trail (auto-generated):
- Source: charts/monitoring/chart/templates/prometheus/auth-proxy.yaml (read 2026-07-05)
- Source: gitops/arc/webhook-ingressroute.yaml (removed in #222)
- Live: kubectl get crd | grep -ci traefik -> 0 (2026-07-05)
- Live: kubectl get ingressroute.traefik.io -A -> none (2026-07-05)
- Git: origin/main PRs #220 (f7856af), #222 (7b054f1)
-->
