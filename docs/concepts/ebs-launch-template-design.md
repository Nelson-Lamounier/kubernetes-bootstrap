# EBS Volumes & Launch Template Design Review

**Reviewed:** 2026-04-21  
**Reviewer:** Claude (via AWS MCP `awsknowledge` knowledge base)  
**Verdict:** Correct pattern. Two considerations require attention: root volume size constraint and NVMe device name resolution.

---

## Context

The compute stack provisions EC2 instances via a Launch Template with two EBS volumes:

- `/dev/xvda` — root volume (always present, overrides AMI defaults)
- `/dev/xvdf` — data volume (conditional on `dataVolumeSizeGb` prop)

The cluster uses the Amazon EBS CSI driver for Kubernetes persistent volume lifecycle. The question is whether the Launch Template block device mappings modify the AMI or create any implications for the CSI driver or bootstrap process.

---

## Does the Launch Template Modify the AMI?

**No. The AMI is immutable.**

The AMI snapshot is a read-only artifact created by EC2 Image Builder. Launch Template block device mappings operate at **instance launch time only** — they instruct EC2 how to configure EBS volumes created *from* that snapshot for a specific instance. The AMI itself is never touched.

**Precedence rule (AWS documented):** When the Launch Template specifies the same device name as the AMI (e.g. `/dev/xvda`), the Launch Template settings override the AMI's own block device mapping for that launch. The AMI block device mapping is the fallback baseline; the Launch Template extends or overrides it per instance.

---

## Volume Breakdown

### `/dev/xvda` — Root Volume Override

```typescript
{
    deviceName: '/dev/xvda',
    volume: ec2.BlockDeviceVolume.ebs(volumeSize, {
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        encrypted: true,
        deleteOnTermination: true,
        iops: volumeIops,
        throughput: volumeThroughput,
    }),
}
```

EC2 creates a fresh GP3 EBS volume from the AMI's root snapshot and applies these parameters at launch time. The AMI snapshot determines filesystem content (the baked OS, Kubernetes binaries, pre-staged scripts). The Launch Template determines size, type, IOPS, throughput, and encryption on the new volume.

**Hard constraint:** `volumeSize` in the Launch Template must be **greater than or equal to** the AMI snapshot's root volume size. EC2 allows growing the root volume from the snapshot, but rejects a launch if the Launch Template specifies a smaller size. If the Golden AMI is baked with a 30 GB root and the Launch Template default is 20 GB, every ASG launch will fail with a volume size error.

**Encryption behaviour:** If the AMI root snapshot is unencrypted and the Launch Template specifies `encrypted: true`, EC2 encrypts the new volume using the account's default KMS key (or a specified KMS CMK) at launch. If the AMI snapshot is already encrypted, it remains encrypted. There is no conflict either way.

### `/dev/xvdf` — Data Volume (Conditional)

```typescript
...(props.dataVolumeSizeGb ? [{
    deviceName: '/dev/xvdf',
    volume: ec2.BlockDeviceVolume.ebs(props.dataVolumeSizeGb, {
        volumeType: ec2.EbsDeviceVolumeType.GP3,
        encrypted: true,
        deleteOnTermination: true,
        iops: volumeIops,
        throughput: volumeThroughput,
    }),
}] : []),
```

This volume does **not** exist in the AMI. EC2 creates a brand-new blank EBS volume and attaches it at instance launch. The bootstrap Python script is solely responsible for formatting and mounting it (to `/data/kubernetes`). No `ec2:AttachVolume` API call is needed at runtime — EC2 handles the attach as part of the launch sequence.

`deleteOnTermination: true` is intentional: nodes are stateless. The data volume is wiped when the instance terminates, which is the correct behaviour for ephemeral Kubernetes node-local storage.

---

## NVMe Device Name on Nitro Instances

**This is the most important operational consideration.**

On all Nitro-based instance families (t3, m5, c5, r5 — all modern instance types), EBS volumes are exposed to the OS as NVMe devices, not the xvd* names specified in the Launch Template:

| Launch Template device name | Actual kernel device (Nitro) |
|---|---|
| `/dev/xvda` (root) | `/dev/nvme0n1` |
| `/dev/xvdf` (data) | `/dev/nvme1n1` (or `nvme2n1` — order not guaranteed) |

AL2023 creates udev symlinks (`/dev/xvdf → /dev/nvme1n1`) so the named path works for most operations. However, **the bootstrap format/mount script must not hardcode `/dev/xvdf`** and assume it is the real block device. Relying on the symlink is fragile when the attach order varies across instance types or when multiple volumes are present.

**Recommended approach in the bootstrap script:** resolve the actual NVMe device by scanning `/dev/disk/by-id/` or using `lsblk` to find the unformatted block device, then format and mount. Example:

```bash
# Find the unformatted data volume by scanning for unpartitioned devices
DATA_DEV=$(lsblk -dpno NAME,FSTYPE | awk '$2=="" && $1!="/dev/nvme0n1" {print $1; exit}')
mkfs.xfs "$DATA_DEV"
mount "$DATA_DEV" /data/kubernetes
```

---

## EBS CSI Driver — No Conflict, Separate Lifecycles

The EBS CSI driver and the Launch Template volumes operate in completely independent layers with no interaction:

| Layer | Managed by | Volumes |
|---|---|---|
| EC2 launch time | Launch Template + EC2 | `/dev/xvda` (root), `/dev/xvdf` (data) |
| Kubernetes PVC lifecycle | EBS CSI driver | Dynamically provisioned PersistentVolumes |

**CSI controller** (runs on control plane): handles `CreateVolume`, `DeleteVolume`, `AttachVolume`, `DetachVolume` RPCs via the AWS EC2 API — exclusively for PVCs requested by Kubernetes workloads. It has no awareness of `/dev/xvda` or `/dev/xvdf`.

**CSI node agent** (DaemonSet on all nodes): handles `NodeStageVolume` and `NodePublishVolume` — mounting a dynamically provisioned EBS volume into a pod's filesystem path. Completely separate from the pre-attached data volume lifecycle.

The instance IAM role requires EBS CSI permissions (`ec2:CreateVolume`, `ec2:AttachVolume`, `ec2:DeleteVolume`, etc.) for the CSI controller to function. These permissions are already granted in the compute stack IAM role. The pre-attached volumes (`/dev/xvda`, `/dev/xvdf`) need no special IAM — EC2 attaches them at launch before any IAM evaluation for application code occurs.

---

## Implications Summary

| Item | Implication | Action Required |
|---|---|---|
| AMI modified by LT? | No — AMI immutable, LT applies at launch only | None |
| Root volume size | LT `volumeSize` must be ≥ AMI snapshot size | Verify `volumeSize` prop is set ≥ Image Builder root size |
| Root volume encryption | LT `encrypted: true` encrypts via default KMS if snapshot is unencrypted | None — correct behaviour |
| `/dev/xvdf` on Nitro | Kernel sees NVMe device, not `/dev/xvdf` | Bootstrap script must resolve actual NVMe device, not hardcode path |
| EBS CSI driver | Manages only dynamically provisioned PVCs — no interaction with pre-attached volumes | None — correct separation |
| `deleteOnTermination: true` | Data volume wiped on termination | Intentional for stateless nodes — correct |
| Data volume at launch | Blank volume, no filesystem | Bootstrap must format + mount before Kubernetes kubelet starts |

---

## Relationship to Golden AMI Pipeline

The data volume (`/dev/xvdf`) is **not** part of the AMI bake. EC2 Image Builder bakes only the root volume snapshot. The data volume is provisioned fresh at every instance launch by EC2, then formatted and mounted by `orchestrator.py` during the bootstrap phase (SM-A execution). This means:

- AMI bake time: root volume only (`/dev/xvda` content baked into snapshot)
- Instance launch time: root volume restored from snapshot + data volume created blank and attached
- Bootstrap phase (SM-A): Python script formats `/dev/xvdf` (actual NVMe device) and mounts to `/data/kubernetes`
- Kubernetes start: kubelet and etcd (on control plane) use `/data/kubernetes` as their data directory

This separation is intentional: the AMI remains small and fast to bake; node-local data storage is provisioned on demand at launch.
