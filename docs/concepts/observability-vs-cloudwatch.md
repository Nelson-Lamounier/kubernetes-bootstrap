---
title: Observability vs CloudWatch
type: concept
tags: [observability, cloudwatch, prometheus, loki, cost, aws, architecture, tradeoffs]
sources:
  - charts/monitoring/chart/templates/grafana/configmap.yaml
  - charts/monitoring/chart/dashboards/cloudwatch.json
  - charts/monitoring/chart/dashboards/cloudwatch-edge.json
  - charts/monitoring/chart/dashboards/auto-bootstrap.json
  - charts/monitoring/chart/dashboards/bedrock.json
  - charts/monitoring/chart/values.yaml
created: 2026-04-28
updated: 2026-04-28
---

# Observability vs CloudWatch

Why this stack runs self-hosted Prometheus/Loki/Tempo alongside two CloudWatch datasources rather than routing everything through CloudWatch — covering the split boundary, per-category rationale, and the Lambda@Edge regional constraint that requires a dedicated `us-east-1` CloudWatch datasource even in a fully self-hosted architecture.

## The split: in-cluster vs out-of-cluster signals

The fundamental division is not preference — it's feasibility:

| Signal category | Storage | Reason |
|----------------|---------|--------|
| Kubernetes pod metrics | Prometheus | cAdvisor + kube-state-metrics emit directly to Prometheus; no CloudWatch agent needed |
| Kubernetes pod logs | Loki (Promtail) | Promtail DaemonSet reads `/var/log/pods` on every node; no CloudWatch agent overhead |
| Application traces | Tempo | OTLP is the transport; CloudWatch X-Ray would require SDK swap |
| Browser RUM | Loki + Tempo (via Alloy) | CloudWatch has no browser SDK equivalent |
| Lambda function logs | CloudWatch | Lambdas write to CloudWatch by default; no in-cluster collector is reachable from Lambda |
| SSM RunCommand output | CloudWatch | SSM writes directly to CloudWatch log groups; cannot redirect |
| Lambda@Edge logs | CloudWatch us-east-1 | Always land in us-east-1 regardless of origin region (AWS constraint) |
| Step Functions execution history | CloudWatch | Step Functions writes execution logs directly to CloudWatch |
| AWS service metrics (EC2, DynamoDB) | CloudWatch | Native service metrics; pulling into Prometheus requires additional exporters |

The self-hosted stack covers cluster-internal signals. CloudWatch covers signals that AWS services emit directly — Lambda, SSM, Step Functions, CloudFront.

## What stays in CloudWatch (and why)

### Lambda function logs

Lambda functions write logs to CloudWatch by default. The only alternative is shipping logs to an external destination (Kinesis Firehose → S3, or CloudWatch Logs subscription filters → external endpoint). Both require:
- Subscription filter Lambda or Firehose delivery stream
- VPC endpoint or public internet routing from Lambda to Loki
- Increased Lambda execution cost (log shipping adds latency)

For a low-frequency Lambda fleet (EIP failover, subscription management, certificate provisioning), CloudWatch log tailing is operationally simpler and cost-equivalent.

### SSM RunCommand output

SSM RunCommand writes stdout/stderr to CloudWatch log groups under `/aws/ssm/`. There is no SSM configuration option to redirect this output elsewhere. The `auto-bootstrap.json` dashboard reads SSM execution logs to show bootstrap step durations and failures — this data is only available from CloudWatch.

### Lambda@Edge logs — the us-east-1 constraint

Lambda@Edge functions are deployed globally but **always write execution logs to CloudWatch in us-east-1**, regardless of which CloudFront edge location served the request. This is an AWS-imposed behaviour: Lambda@Edge execution context runs in the edge location, but logs are aggregated to the `us-east-1` region's CloudWatch.

The consequence: even a cluster running entirely in `eu-west-1` needs a second CloudWatch datasource pointing at `us-east-1` to access logs from:
- Next.js Edge middleware (runs at CloudFront edge)
- ACM DNS validation Lambda (certificate provisioning automation)
- DNS alias management Lambdas

The `cloudwatch-edge.json` dashboard exists solely because of this constraint. All its panels are CloudWatch metrics/logs queries to `us-east-1` — there is no equivalent in-cluster signal source.

### Bedrock / AI pipeline metrics

The Bedrock content pipeline runs entirely in Lambda + DynamoDB + Bedrock. Its metrics (articles published, token usage, estimated cost) are emitted as CloudWatch EMF (Embedded Metric Format) directly from the Lambda functions. The `bedrock.json` dashboard reads these EMF metrics — pulling them into Prometheus would require a custom exporter that polls CloudWatch Metrics API.

## Self-hosted stack: cost and operational profile

**Storage cost:** Four EBS PVCs of 5–10Gi each. At ~$0.10/GB-month for gp3 EBS, the total PVC storage runs ~$3–4/month for development (5Gi each) and ~$8/month for production (10Gi each). This is significantly lower than equivalent CloudWatch retention costs for the same volume of metrics and logs.

**CloudWatch costs avoided by self-hosting:**
- Prometheus scrapes cluster metrics at 30s intervals. Equivalent CloudWatch custom metrics would be billed per metric per month (approximately $0.30/metric/month for standard resolution). A cluster with 1000 active Prometheus series would cost ~$300/month in CloudWatch vs ~$4/month in EBS storage.
- Loki stores pod logs at a fraction of CloudWatch Logs ingestion + storage cost ($0.50/GB ingestion + $0.03/GB-month storage in CloudWatch vs EBS PVC at ~$0.10/GB-month flat).

**Operational cost:** Self-hosted stack requires managing Prometheus, Loki, Tempo, Alloy, Grafana — storage provisioning, retention configuration, pod disruption budgets. CloudWatch is fully managed. The operational investment is justified at this stack's scale by the query flexibility (PromQL, LogQL, TraceQL) that CloudWatch Logs Insights and CloudWatch Metrics cannot match.

**Query model:** PromQL/LogQL/TraceQL are significantly more expressive than CloudWatch's query languages for infrastructure observability. `histogram_quantile`, multi-dimensional aggregations, label-joining joins across metrics sources, and exemplar linking to traces are not available in CloudWatch's native query path.

## Signals that use both (hybrid dashboards)

Some dashboards combine in-cluster Prometheus and CloudWatch data in the same view:

**`tracing.json`** — most panels use Prometheus span metrics (generated by Tempo from OTLP traces). Two panels use CloudWatch directly for DynamoDB consumed RCU/WCU and throttled requests — because these are AWS-native DynamoDB capacity metrics that only exist in CloudWatch, not derivable from application-level traces.

**`auto-bootstrap.json`** — entirely CloudWatch. The bootstrap pipeline runs before the Kubernetes cluster (and Prometheus) exists. There are no in-cluster metrics for Step Functions executions — by definition the cluster is being created during those executions.

## Why this split is stable

The boundary is durable because it follows AWS service boundaries:

- Services that run inside the cluster → in-cluster collectors (Prometheus, Loki, Tempo)
- Services that AWS manages directly (Lambda, SSM, Step Functions, CloudFront) → CloudWatch

The only case where the boundary might shift is if a future requirement adds CloudWatch Container Insights or X-Ray for Kubernetes pods — but adding those would increase cost significantly and duplicate what Prometheus/Loki already provide.

## Related

- [Observability stack](../projects/observability-stack.md) — full component inventory
- [Grafana datasources](../tools/grafana-datasources.md) — CloudWatch datasource configuration and the us-east-1 dual-datasource setup
- [Dashboard architecture](dashboard-architecture.md) — which dashboards use which datasource, including the hybrid Prometheus+CloudWatch dashboards

<!--
Evidence trail (auto-generated):
- Source: charts/monitoring/chart/templates/grafana/configmap.yaml (read 2026-04-28 — CloudWatch eu-west-1 and us-east-1 datasource definitions, authType: default)
- Source: charts/monitoring/chart/dashboards/cloudwatch.json (read 2026-04-28 — Lambda logs, SSM logs, EC2 cloud-init, VPC flow logs panels)
- Source: charts/monitoring/chart/dashboards/cloudwatch-edge.json (read 2026-04-28 — Lambda@Edge logs us-east-1 panels, cert/DNS Lambda logs)
- Source: charts/monitoring/chart/dashboards/auto-bootstrap.json (read 2026-04-28 — all panels CloudWatch, Step Functions metrics, SSM execution output)
- Source: charts/monitoring/chart/dashboards/bedrock.json (read 2026-04-28 — all panels CloudWatch, EMF metrics, Lambda metrics)
- Source: charts/monitoring/chart/values.yaml (read 2026-04-28 — EBS PVC sizes for cost analysis)
- Generated: 2026-04-28
-->
