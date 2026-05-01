{{/*
Common labels applied to all resources.
*/}}
{{- define "tucaken-app.labels" -}}
app.kubernetes.io/managed-by: helm
app.kubernetes.io/part-of: tucaken-app
{{- end }}

{{/*
Selector labels for the tucaken-app component.
Usage: {{ include "tucaken-app.selectorLabels" . }}
*/}}
{{- define "tucaken-app.selectorLabels" -}}
app: tucaken-app
{{- end }}

{{/*
Full labels: common + selector.
Usage: {{ include "tucaken-app.fullLabels" . }}
*/}}
{{- define "tucaken-app.fullLabels" -}}
{{ include "tucaken-app.labels" . }}
{{ include "tucaken-app.selectorLabels" . }}
{{- end }}
