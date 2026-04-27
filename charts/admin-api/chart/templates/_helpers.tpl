{{/*
  admin-api — Shared template helpers
*/}}

{{/* Selector labels — used in Service and Deployment matchLabels */}}
{{- define "admin-api.selectorLabels" -}}
app.kubernetes.io/name: admin-api
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Full labels — selector labels + chart metadata */}}
{{- define "admin-api.fullLabels" -}}
{{ include "admin-api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: bff
app.kubernetes.io/part-of: portfolio-admin
{{- end }}
