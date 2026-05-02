{{- define "argocd-ingress.labels" -}}
app.kubernetes.io/part-of: argocd
app.kubernetes.io/managed-by: helm
{{- end }}
