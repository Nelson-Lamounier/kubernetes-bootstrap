{{/*
Common labels applied to all resources.
*/}}
{{- define "monitoring.labels" -}}
app.kubernetes.io/managed-by: helm
app.kubernetes.io/part-of: monitoring
{{- end }}

{{/*
Selector labels for a given component.
Usage: {{ include "monitoring.selectorLabels" "prometheus" }}
*/}}
{{- define "monitoring.selectorLabels" -}}
app: {{ . }}
{{- end }}

{{/*
Full labels: common + selector.
Usage: {{ include "monitoring.fullLabels" "grafana" }}
*/}}
{{- define "monitoring.fullLabels" -}}
{{ include "monitoring.labels" . }}
{{ include "monitoring.selectorLabels" . }}
{{- end }}
