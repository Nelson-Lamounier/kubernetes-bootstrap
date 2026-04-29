{{/*
Common labels applied to all resources.
*/}}
{{- define "start-admin.labels" -}}
app.kubernetes.io/managed-by: helm
app.kubernetes.io/part-of: start-admin
{{- end }}

{{/*
Selector labels for the start-admin component.
Usage: {{ include "start-admin.selectorLabels" . }}
*/}}
{{- define "start-admin.selectorLabels" -}}
app: start-admin
{{- end }}

{{/*
Full labels: common + selector.
Usage: {{ include "start-admin.fullLabels" . }}
*/}}
{{- define "start-admin.fullLabels" -}}
{{ include "start-admin.labels" . }}
{{ include "start-admin.selectorLabels" . }}
{{- end }}
