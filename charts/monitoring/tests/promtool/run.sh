#!/usr/bin/env bash
# Render the observability rules out of the Helm template and run promtool's
# unit tests against them. Used locally and in CI to guard the dashboards'
# pipeline-integrity alerts.
set -euo pipefail
cd "$(dirname "$0")/../.."   # -> charts/monitoring

helm template m chart \
  -f chart/values.yaml -f chart/values-development.yaml \
  --show-only templates/prometheus/rules-observability-configmap.yaml \
| awk '/^  observability\.yml: \|/{f=1;next} f{sub(/^    /,"");print}' \
  > tests/promtool/observability.rules.yml

promtool check rules tests/promtool/observability.rules.yml
promtool test rules tests/promtool/observability.test.yml
