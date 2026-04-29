# Control Plane Bootstrap Failure Analysis — v3 (with AMI build logs)

**Component failure (real root cause)**
- Image ARN: `arn:aws:imagebuilder:eu-west-1:771826808455:image/k8s-development-golden-ami-recipe/69.40.166/1`
- Component: `k8s-development-golden-ami-install/69.40.166/1`
- Failed step: `ApplyBuildComponents`
- Failed SSM command: `519f0c93-218f-418e-b955-686e3072623a` on build instance `i-09c9416addac91261`
- AMI build failed: 2026-04-25 **17:56:30 UTC**

**Downstream control-plane bootstrap (v1 / v2 subject)**
- Instance: `i-052806c21ab79d265` running on the *previous* AMI (the new one never published)
- Bootstrap started: 2026-04-25 **18:00:18 UTC** (~3m 48s after the AMI failure)
- Bootstrap exited 1 at 18:03:52 UTC

---

## What changed from v2

v2 correctly identified that `/opt/k8s-bootstrap/sm-a/argocd/bootstrap_argocd.ts` was missing from the running control-plane instance, and floated AMI vs S3 as alternative deployment models. The Image Builder logs now show *why* the file is missing: the AMI version `69.40.166/1` that was intended to ship that file never finished baking. The `ApplyBuildComponents` step failed in 67 seconds, the build instance was terminated by Image Builder's rollback, no AMI was published, and the launch template kept resolving to the previous (older, missing-the-file) image.

The control-plane orchestration then ran on a stale AMI without anyone noticing — there is no gate between AMI build and downstream EC2 launch. That's the structural gap.

The earlier findings about the control-plane label, the CCM uninitialized taint, and the WARN-reported-as-OK pattern are still valid and still need fixing — none of those are caused by the AMI bake failure. They were already broken in the older AMI; the new AMI may or may not have fixed them.

## Cause hierarchy

```
1. ApplyBuildComponents step failed during AMI bake (root cause — unknown error inside component)
       │
       ├─► AMI 69.40.166/1 never published; launch template still points at older AMI
       │       │
       │       ├─► sm-a/argocd/bootstrap_argocd.ts not present on the running instance
       │       │       │
       │       │       └─► bootstrap-argocd step exits 1 (the visible failure in Step Functions)
       │       │
       │       └─► Whatever else 69.40.166 was meant to fix is also absent (unknown scope)
       │
       └─► (independent) Pre-existing bugs in second-run maintenance still ride along:
               ├─ control-plane label never re-applied → CCM uninitialized taint never removed
               └─ WARN steps falsely report success
```

## What the Image Builder logs tell us — and what they don't

Visible from the workflow log:

- The build component executed for ~67 s before failing (command sent 17:54:34, marked Failed at 17:55:42, after three 30-s polling intervals).
- Image Builder reports `Document ... failed!` but does not embed the failed component's stdout/stderr in the workflow log.
- The build instance was terminated as part of rollback (`Terminate Instance On Failure: True`), which means there is no longer a live instance to SSH into for diagnosis.

Not visible (need to fetch separately):

- The actual stdout/stderr of SSM command `519f0c93-218f-418e-b955-686e3072623a`. Image Builder writes component output either to S3 (if configured in the infrastructure configuration) or to CloudWatch under a path like `/aws/imagebuilder/<recipe-name>`. Pull from whichever is configured:

  ```bash
  # CloudWatch path (most likely)
  aws logs tail /aws/imagebuilder/k8s-development-golden-ami-recipe --since 1h --region eu-west-1

  # Or list commands and inspect (the instance is gone, so this is best-effort)
  aws ssm list-commands --command-id 519f0c93-218f-418e-b955-686e3072623a --region eu-west-1
  ```

- The component definition itself — `k8s-development-golden-ami-install/69.40.166/1` — needs to be inspected for what actually changed in this version vs the previous successful build:

  ```bash
  aws imagebuilder get-component \
    --component-build-version-arn arn:aws:imagebuilder:eu-west-1:771826808455:component/k8s-development-golden-ami-install/69.40.166/1 \
    --region eu-west-1
  ```

  Compare the `data` field against the last-known-good version. The 67-second runtime suggests the failure is early in the component — typical suspects in this phase are package installs (dnf/yum), container image pre-pulls, file copies from S3, or the script that lays down the `sm-a/` tree onto the AMI filesystem.

## New findings the AMI logs surface

### Gap A — No gate between AMI build and downstream orchestration (severity: high, structural)

The control-plane EC2 was launched ~3m 48s after the AMI build failed, on the previous AMI. There is no mechanism that says "if today's AMI build failed, do not roll forward; either pin to the last-known-good AMI explicitly or fail loudly." The current shape silently degrades to whatever AMI the launch template can resolve, which means a broken AMI build is invisible to anyone watching the bootstrap pipeline.

Fix options, in order of effort:

1. **Cheapest:** add an EventBridge rule on `EC2 Image Builder Image State Change` for `state = FAILED` that publishes an SNS alert. Doesn't gate, but at least makes the failure visible.
2. **Better:** the launch template's AMI parameter should reference an SSM parameter (e.g. `/k8s/development/ami/golden`) that is *only* updated on successful Image Builder runs. The AMI build and the parameter update are then atomic — failed builds don't change the parameter.
3. **Best:** the Step Functions orchestrator that triggers the control-plane bootstrap takes the current expected AMI version as input and refuses to proceed if the running instance's AMI doesn't match. This catches the "instance was launched before the AMI build but the orchestrator started after" race too.

### Gap B — Build instance terminated immediately on failure makes diagnosis harder (severity: medium, observability)

`Terminate Instance On Failure: True` is the default, and it means by the time anyone looks at the Image Builder failure, the build instance is gone. For a reliably-failing component, this is fine — re-run with the terminate flag flipped to inspect interactively. But each diagnosis cycle costs ~2 min of build time before the failure manifests, which is friction.

For the dev account specifically, consider setting `terminateInstanceOnFailure: false` for the next failure-investigation cycle, then flipping it back when the issue is resolved. Or wire up a Lambda triggered by the `FAILED` state-change event that captures `aws ssm get-command-invocation` output for the failed CommandId before the instance is terminated.

### Gap C — Component-level failure does not bubble actionable information into the workflow log (severity: medium, observability)

The workflow log says `Document arn:aws:imagebuilder:...component/k8s-development-golden-ami-install/69.40.166/1 failed!` and stops. To find out what actually broke, an operator has to:

1. Note the failed CommandId from the Step Functions / Image Builder log
2. Find the right CloudWatch log group (which depends on infrastructure-configuration settings most operators don't have memorised)
3. Pull the tail of stdout/stderr
4. Cross-reference against the component definition to figure out which line failed

Same shape as the v2 Gap 7 problem one layer down: failure formatters everywhere in this pipeline assume the operator already knows where the real logs live. Add a lambda-backed enrichment step that includes the component's last 100 stderr lines in the Image Builder failure notification.

## Findings that survive from v2 (unchanged)

These are independent of the AMI bake failure and need fixing regardless of how the AMI issue is resolved:

- **v2 Gap 2** — `install-ccm` silently completes with `node.cloudprovider.kubernetes.io/uninitialized` taint still present. Cluster is functionally broken even when bootstrap-argocd succeeds.
- **v2 Gap 3** — control-plane label query fails twice (init-kubeadm, configure-kubectl) and is never repaired. Almost certainly the upstream cause of the CCM issue.
- **v2 Gap 4** — `install-calico` force-rebuild adds ~58 s on every run, including healthy maintenance runs.
- **v2 Gap 5** — three steps in the bootstrap log a WARN that materially affects cluster health and report OK. Need a step-result enum.
- **v2 Gap 6** — inconsistent code-deployment model (S3 sync for some paths, AMI bake for others). The AMI bake failure is exactly the kind of issue this hybrid model creates: a script change shipped via AMI is invisible to anyone reading the SSM document.
- **v2 Gap 7** — Step Functions Cause field truncates the SSM stdout snapshot.
- **v2 Gap 8** — apiserver cert SANs include public IP unnecessarily.

## Updated recommendations, in priority order

1. **Diagnose the component failure.** Pull `/aws/imagebuilder/k8s-development-golden-ami-recipe` CloudWatch logs and `get-component` on `69.40.166/1`. Compare the component data against the last-known-good version. The 67-second execution window points to an early-phase failure — package install, file copy, or script lay-down.

2. **Add a gate between AMI build and downstream orchestration** (Gap A). At minimum an SNS alert on FAILED; ideally an SSM-parameter-pinned launch template AMI that only updates on successful builds.

3. **Resolve v2 Gap 6** — pick AMI or S3 for code deployment, not both. The AMI bake failure made this concrete: a deployment that depends on AMI bakes is fragile in exactly this way. If `sm-a/argocd/bootstrap_argocd.ts` were synced from S3 like its sibling `sm-a/boot/steps/`, the control-plane bootstrap would have succeeded today regardless of the AMI build outcome.

4. **Apply the control-plane label explicitly in init-kubeadm** (v2 Gap 3). Independent of AMI, this is what's breaking CCM.

5. **Verify CCM after fixing #4** (v2 Gap 2). If the uninitialized taint still doesn't clear, separate investigation needed.

6. **Add a step-result enum** (v2 Gap 5). DEGRADED ≠ OK at any layer of this pipeline.

7. **Replace failure formatters with log-tail fetchers** (Gap C, v2 Gap 7) at both Image Builder and Step Functions layers.

8. **Gate Calico force-rebuild behind a transient DR marker** (v2 Gap 4).

9. **Drop public IP from apiserver cert SANs** (v2 Gap 8).

---

## One-line summary

`bootstrap-argocd` exited 1 because the AMI bake that would have placed the file on disk failed 4 minutes before the EC2 instance launched, and nothing in the pipeline noticed the AMI build had failed — meanwhile, the cluster was already functionally broken before that step ran because the AWS CCM never removed the `uninitialized` taint, almost certainly because the control-plane node was never labelled. The next investigation is the CloudWatch tail for SSM command `519f0c93-218f-418e-b955-686e3072623a` on the (now-terminated) build instance.