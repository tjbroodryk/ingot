{{/*
Names. Standard Helm shape — `ingot.fullname` is the release name unless it
already contains the chart name, which keeps `helm install ingot ./charts/ingot`
from producing `ingot-ingot`.
*/}}
{{- define "ingot.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ingot.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "ingot.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Labels.

Written out per component rather than composed from a shared block, because a
composed one produces `app.kubernetes.io/instance` twice — once from the common
labels and once from the selector — and a duplicate key in a YAML map is an
error that points at the rendered output rather than at the template.
*/}}
{{- define "ingot.server.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ingot.name" . }}-server
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ingot.server.labels" -}}
helm.sh/chart: {{ include "ingot.chart" . }}
{{ include "ingot.server.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: api
app.kubernetes.io/part-of: ingot
{{- end }}

{{- define "ingot.app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ingot.name" . }}-app
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ingot.app.labels" -}}
helm.sh/chart: {{ include "ingot.chart" . }}
{{ include "ingot.app.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: web
app.kubernetes.io/part-of: ingot
{{- end }}

{{/*
Images. An empty `tag` means `Chart.appVersion`, so pinning a release is one
value rather than two.
*/}}
{{- define "ingot.server.image" -}}
{{- printf "%s:%s" .Values.server.image.repository (.Values.server.image.tag | default .Chart.AppVersion) -}}
{{- end }}

{{- define "ingot.app.image" -}}
{{- printf "%s:%s" .Values.app.image.repository (.Values.app.image.tag | default .Chart.AppVersion) -}}
{{- end }}

{{- define "ingot.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ingot.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end }}

{{/*
Which Secret the pods read. Either the one this chart makes or the one you did,
and never neither — see `ingot.validate`.
*/}}
{{- define "ingot.secretName" -}}
{{- if .Values.secrets.create -}}
{{- printf "%s-secrets" (include "ingot.fullname" .) -}}
{{- else -}}
{{- .Values.secrets.existingSecret -}}
{{- end -}}
{{- end }}

{{/*
Refuse to render, rather than install something that will crashloop.

This is the same rule the service applies to itself: `DATABASE_URL` and
`INGOT_STORAGE` refuse to boot half-configured, because the alternative is a
deployment quietly writing its base tier to a container's writable layer. The
difference is only how early you find out — `helm install` rather than the
third CrashLoopBackOff.

Included from `configmap.yaml`, which always renders. Helm attributes the
failure to whichever template pulled it in — usually `server-deployment.yaml`,
via the config checksum on its pod template — so ignore the file and line it
prints and read the message, which says what to set and why.
*/}}
{{- define "ingot.validate" -}}

{{- if not (or .Values.secrets.create .Values.secrets.existingSecret) }}
{{- fail "\n\nNo secret to read.\n\nDATABASE_URL is the one setting with no default. Either point the chart at a\nSecret you made:\n\n  kubectl -n <ns> create secret generic ingot-secrets \\\n    --from-literal=DATABASE_URL='postgres://…'\n  helm … --set secrets.existingSecret=ingot-secrets\n\nor let the chart make one with --set secrets.create=true and the values under\n`secrets:`.\n" }}
{{- end }}

{{- if and .Values.secrets.create (not .Values.secrets.databaseUrl) }}
{{- fail "\n\nsecrets.create is true but secrets.databaseUrl is empty.\n\nIngot refuses to start without a database rather than inventing an address for\none, so there is nothing useful to install here.\n" }}
{{- end }}

{{- $auth := .Values.config.auth.mode }}
{{- if not (has $auth (list "sealed")) }}
{{- fail (printf "\n\nconfig.auth.mode is %q — the only mode this chart knows is `sealed`.\n" $auth) }}
{{- end }}

{{- if not .Values.config.auth.account }}
{{- fail "\n\nconfig.auth.account is empty.\n\nA sealed deployment serves exactly one account, and its slug is the first\nsegment of every route — /api/v1/<account>/<ingot>/add. There is no sensible\ndefault for someone else's URLs, so name it:\n\n  helm … --set config.auth.account=acme\n" }}
{{- end }}

{{- if and .Values.secrets.create (not .Values.secrets.apiKey) }}
{{- fail "\n\nsecrets.create is true but secrets.apiKey is empty.\n\nThat is the root credential for config.auth.account, and the service refuses to\nstart without one. Generate it rather than choosing it:\n\n  --set secrets.apiKey=\"ing_sk_$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')\"\n" }}
{{- end }}

{{- /*
  The root key is not checked when the Secret is yours. It may be there under
  INGOT_API_KEY without this chart being able to see it — the same reason the
  S3 access keys below are left alone. The service checks it at boot, and
  refuses to start rather than serve without one.
*/}}

{{- $storage := .Values.config.storage }}
{{- if not (has $storage (list "filesystem" "s3" "gcs")) }}
{{- fail (printf "\n\nconfig.storage is %q — it must be one of filesystem, s3 or gcs.\n" $storage) }}
{{- end }}

{{- if eq $storage "s3" }}
  {{- if not .Values.config.s3.bucket }}
  {{- fail "\n\nconfig.storage is s3 but config.s3.bucket is empty.\n\nA bucket variable without the rest is refused at boot too — half-filled storage\nconfiguration is the case Ingot will not guess at.\n" }}
  {{- end }}
  {{- /*
    The access keys are deliberately not checked. They may be in an existing
    Secret this chart cannot read, or absent on purpose because an IRSA role on
    the ServiceAccount is handing credentials to the SDK's provider chain
    instead. Failing on "no keys" would refuse the better of the two setups.
  */ -}}
{{- end }}

{{- if eq $storage "gcs" }}
  {{- if not .Values.config.gcs.bucket }}
  {{- fail "\n\nconfig.storage is gcs but config.gcs.bucket is empty.\n" }}
  {{- end }}
{{- end }}

{{- if eq $storage "filesystem" }}
  {{- if not .Values.config.filesystem.persistence.enabled }}
  {{- fail "\n\nconfig.storage is filesystem but config.filesystem.persistence.enabled is false.\n\nThe base tier would land on an emptyDir, which an eviction takes with it — the\nParquet is the data, not a cache. Enable persistence, or use s3/gcs.\n" }}
  {{- end }}
  {{- $rwo := eq .Values.config.filesystem.persistence.accessMode "ReadWriteOnce" }}
  {{- $many := or .Values.server.autoscaling.enabled (gt (int .Values.server.replicaCount) 1) }}
  {{- if and $rwo $many }}
  {{- fail "\n\nconfig.storage is filesystem on a ReadWriteOnce volume, with more than one\nserver replica asked for.\n\nOne pod can mount it. Set server.replicaCount=1 and\nserver.autoscaling.enabled=false, or give the volume a ReadWriteMany class — a\nGCS FUSE CSI volume or an S3 CSI driver is a perfectly good way to run this.\n" }}
  {{- end }}
{{- end }}

{{- if and .Values.ingress.enabled (not .Values.ingress.host) }}
{{- fail "\n\ningress.enabled is true but ingress.host is empty.\n\nAn Ingress carrying no host matches every request that reaches the controller,\nwhich is rarely what anyone means and never what they meant by accident.\n" }}
{{- end }}

{{- end }}
