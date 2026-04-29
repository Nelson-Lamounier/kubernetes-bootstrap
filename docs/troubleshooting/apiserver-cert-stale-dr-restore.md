---
title: Apiserver Cert SANs Stale After DR Restore — Kubelet Fails to Register
type: troubleshooting
tags: [kubernetes, kubeadm, dr-restore, tls, certificates, kubelet, bootstrap]
sources:
  - sm-a/boot/steps/control_plane.ts
created: 2026-04-29
updated: 2026-04-29
---

# Apiserver Cert SANs Stale After DR Restore — Kubelet Fails to Register

## Symptom

After a DR restore, the Kubernetes API server is reachable and `/healthz` returns `ok`, but the node never appears in `kubectl get nodes`. The kubelet journal shows a TLS certificate error:

```
x509: certificate is valid for 10.96.0.1, 10.0.0.248, 127.0.0.1, 108.130.230.42, not 10.0.0.219
```

The bootstrap step `init-kubeadm` waits indefinitely for node registration, then times out. Subsequent steps (`install-calico`, `install-ccm`) may never run.

## Root cause

The apiserver TLS certificate (`/etc/kubernetes/pki/apiserver.crt`) is restored from the S3 etcd snapshot with the **previous EC2 instance's** IP addresses in its Subject Alternative Names. When the replacement instance gets a different private IP, the certificate's SANs no longer include that IP.

The deceptive aspect: the bootstrap uses `curl https://127.0.0.1:6443/healthz` to test API server reachability — and `127.0.0.1` **is** in the restored cert's SANs, so this check passes. But the kubelet posts node registration directly to `https://<private-ip>:6443/api/v1/nodes`, which hits the IP path — and that IP is **not** in the cert.

Compound failure: after the initial TLS rejection, kubelet enters exponential backoff — the interval between registration attempts can grow to minutes. Restarting the kubelet resets the backoff counter and forces an immediate retry.

Source: `sm-a/boot/steps/control_plane.ts` — `ensureApiserverCertCurrent()` — commits `286fd41` and `0ef1e16`.

## How to diagnose

```bash
# 1. Confirm /healthz is reachable (expected: "ok")
curl -sk https://127.0.0.1:6443/healthz

# 2. Get the current private IP of this instance
TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
PRIVATE_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
  "http://169.254.169.254/latest/meta-data/local-ipv4")
echo "Current private IP: $PRIVATE_IP"

# 3. Check the apiserver cert's current SANs
openssl x509 -noout -ext subjectAltName \
  -in /etc/kubernetes/pki/apiserver.crt
# Expected to include: IP:$PRIVATE_IP
# If absent → cert is stale

# 4. Confirm kubelet is failing with the cert error
journalctl -u kubelet --no-pager -n 30 | grep -i "x509\|certificate\|SAN\|not.*valid"

# 5. Check kubelet backoff state
systemctl show kubelet --property=NRestarts,ActiveState
# NRestarts > 3 and ActiveState=failed → exponential backoff in effect
```

## How to fix

### Automated fix (runs on every second-run / DR restore)

`ensureApiserverCertCurrent()` in `sm-a/boot/steps/control_plane.ts` performs this automatically. It runs in the `handleSecondRun()` path (when `/etc/kubernetes/admin.conf` already exists).

The function:
1. Parses the current SANs from `/etc/kubernetes/pki/apiserver.crt` via `openssl x509 -ext subjectAltName`
2. Compares against the expected set: `[127.0.0.1, <private-ip>, k8s-api.k8s.internal]`
3. If the private IP is absent: deletes `apiserver.crt` + `apiserver.key`, regenerates via `kubeadm init phase certs apiserver`
4. Kills the apiserver static pod container with `crictl stopp <id>` to force kubelet to re-read the new cert
5. Restarts kubelet (`systemctl restart kubelet`) to reset the exponential backoff counter
6. Waits for `/healthz` to return `ok` before proceeding

### Manual fix

If running the bootstrap script is not an option:

```bash
# Step 1 — get private IP from IMDS
TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
PRIVATE_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
  "http://169.254.169.254/latest/meta-data/local-ipv4")

# Step 2 — delete stale cert and key
rm /etc/kubernetes/pki/apiserver.crt /etc/kubernetes/pki/apiserver.key

# Step 3 — regenerate with correct SANs
kubeadm init phase certs apiserver \
  --control-plane-endpoint=k8s-api.k8s.internal:6443 \
  --apiserver-cert-extra-sans="127.0.0.1,${PRIVATE_IP},k8s-api.k8s.internal"

# Step 4 — verify new SANs include current private IP
openssl x509 -noout -ext subjectAltName \
  -in /etc/kubernetes/pki/apiserver.crt | grep "$PRIVATE_IP"

# Step 5 — kill the apiserver static pod so kubelet picks up the new cert
APISERVER_POD=$(crictl pods --namespace kube-system --name kube-apiserver -q)
crictl stopp "$APISERVER_POD"

# Step 6 — restart kubelet to reset exponential backoff
systemctl restart kubelet

# Step 7 — wait for API server recovery
until curl -sk https://127.0.0.1:6443/healthz | grep -q "ok"; do
  echo "Waiting for apiserver..."; sleep 3
done

# Step 8 — confirm node appears
kubectl get nodes
```

## How to prevent

`ensureApiserverCertCurrent()` runs unconditionally on every second-run bootstrap invocation. It compares the live cert SANs to the expected set, so even if the private IP changes between restarts it catches and corrects the mismatch within the same bootstrap run.

The public IP was intentionally dropped from the SAN set (commit `7c9ee69`) because the public IP rotates on every EC2 stop/start, which was causing unnecessary cert regenerations. All external traffic routes through `k8s-api.k8s.internal` (stable Route53 record), so no external client needs the ephemeral public IP in the cert.

If this fires during a manual DR restore without triggering the bootstrap script, run `ensureApiserverCertCurrent` logic above before proceeding to Calico installation — the node must appear in `kubectl get nodes` before Calico can schedule `calico-node` on it.

## Related

- [Calico stuck Pending on DR restore](calico-dr-restore-stuck.md) — fires on the same run, after this issue is resolved
- [kubeadm Control Plane Init — OS-Level Runbook](../runbooks/kubeadm-control-plane-init.md) — second-run maintenance path, `ensureApiserverCertCurrent` procedure
- [Kubernetes Bootstrap Orchestrator](../projects/kubernetes-bootstrap-orchestrator.md) — Step Functions state machine, 10-step control plane sequence

<!--
Evidence trail (auto-generated):
- Source: sm-a/boot/steps/control_plane.ts (read 2026-04-28, 1573 lines — ensureApiserverCertCurrent(), handleSecondRun(), ADMIN_CONF existence check)
- Commit: 286fd41 fix(cp): regen stale apiserver cert after dr-restore so kubelet can register — root cause analysis with exact x509 error message and IP addresses
- Commit: 0ef1e16 fix(bootstrap): restart kubelet in second-run to reset node-registration backoff — compound failure with exponential backoff
- Commit: 7c9ee69 fix(boot): drop public IP from apiserver cert SANs — explains why public IP is absent from SAN list
- Generated: 2026-04-29
-->
