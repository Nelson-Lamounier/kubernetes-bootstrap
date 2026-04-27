{{/*
Common labels applied to all resources.
*/}}
{{- define "nextjs.labels" -}}
app.kubernetes.io/managed-by: helm
app.kubernetes.io/part-of: nextjs
{{- end }}

{{/*
Selector labels for the nextjs component.
Usage: {{ include "nextjs.selectorLabels" . }}
*/}}
{{- define "nextjs.selectorLabels" -}}
app: nextjs
{{- end }}

{{/*
Full labels: common + selector.
Usage: {{ include "nextjs.fullLabels" . }}
*/}}
{{- define "nextjs.fullLabels" -}}
{{ include "nextjs.labels" . }}
{{ include "nextjs.selectorLabels" . }}
{{- end }}
