# AMI Refresh State Machine Failure — `r.send is not a function`

**Execution ARN:** `arn:aws:states:eu-west-1:771826808455:execution:k8s-development-ami-refresh:8e226ec0-232d-b648-5b42-3cf7ffc4015b_f78e311e-18d6-55d3-c6c3-16a6df644351`
**Lambda:** `ControlPlane-development-AmiRefreshUpdateLtFnF3DB0-lKJZkqqmN0xW`
**Started:** 2026-04-26 08:53:18 UTC
**Failed:** 2026-04-26 08:55:43 UTC (~2m 24s, all of it spent in retries)
**Final state:** `WorkerRefreshFailed` — "Worker ASG instance refresh failed — check Lambda logs in CloudWatch"

---

## What happened

The state machine entered `UpdateWorkerTemplates`, invoked the Lambda four times across the standard Step Functions retry policy (1.2s, 30s, 45s, 67s gaps — exponential backoff with jitter), and got the same error every time:

```
TypeError: r.send is not a function
  at Runtime.T [as handler] (/var/task/index.js:1:804)
  at Runtime.handleOnceNonStreaming (file:///var/runtime/index.mjs:1306:29)
```

After exhausting retries the state machine transitioned to the `WorkerRefreshFailed` Fail state.

This is not an AWS-side or permissions error. The Lambda is crashing on its own code before it does any meaningful work — the stack trace bottoms out at column 804 of a one-line minified `index.js`, with no AWS SDK frames in the trace, which means the failure is at the moment the handler tries to call something it expects to be an AWS SDK client.

## Root cause: bundling produced a broken AWS SDK client

`r.send is not a function` from a Lambda built with bundled JS is the canonical signature of one specific bug: the AWS SDK v3 client class was bundled in a way that destroyed its prototype chain, so `new SomeClient(...).send(command)` evaluates to `undefined.send(...)`.

The exact fingerprint:

- `index.js:1:804` — minified single-line bundle (esbuild output)
- `r` is a one-letter minified variable, almost certainly the SDK client instance
- `.send` is the standard call pattern for SDK v3 clients (`EC2Client`, `AutoScalingClient`, etc.)

Three plausible causes, in decreasing order of likelihood:

1. **AWS SDK got bundled instead of marked external, and tree-shaking dropped the prototype.** Lambda Node 18+ runtimes have AWS SDK v3 pre-installed at `/var/runtime/node_modules/@aws-sdk/*`. If the build bundles it in anyway with aggressive minification, certain SDK class definitions can lose their `.prototype.send` method during dead-code elimination. The fix is to mark `@aws-sdk/*` as external in the bundler config so Lambda uses the runtime-provided copy.

2. **Mixed v2/v3 SDK imports.** Code imports something like `const EC2 = require('aws-sdk').EC2` (v2-style) but instantiates it expecting v3 semantics, or vice versa. v2 clients use `.send(callback)` differently from v3, and a mismatch produces this error pattern.

3. **A non-client object got `.send()` called on it.** Less likely given the minified `r` variable name pattern, but a recent refactor that reassigned a variable previously holding a client could match this.

The 1ms-fast failure (every invocation crashes in ~150-400ms total, with the actual error happening even faster than that) confirms the handler is dying immediately on first SDK usage, not after any meaningful work.

## Diagnosis steps

The Step Functions log says "check Lambda logs in CloudWatch" and that's the right next step. The Lambda's CloudWatch log group is `/aws/lambda/ControlPlane-development-AmiRefreshUpdateLtFnF3DB0-lKJZkqqmN0xW`. The handler crashes before any of its own logging runs, but you should still see the unhandled exception with column position context:

```bash
aws logs tail /aws/lambda/ControlPlane-development-AmiRefreshUpdateLtFnF3DB0-lKJZkqqmN0xW \
  --since 30m --region eu-west-1
```

To confirm the bundling hypothesis directly:

```bash
# Pull the deployed code and check whether @aws-sdk is bundled in
aws lambda get-function \
  --function-name ControlPlane-development-AmiRefreshUpdateLtFnF3DB0-lKJZkqqmN0xW \
  --region eu-west-1 \
  --query 'Code.Location' --output text | xargs curl -s -o /tmp/lambda.zip
unzip -l /tmp/lambda.zip | head
# If you see only index.js (no node_modules/), AWS SDK was bundled.
# If you see node_modules/@aws-sdk/, it's external — different bug.
```

If your CDK uses `NodejsFunction`, check the `bundling.externalModules` setting — by default in CDK v2 it externalises `@aws-sdk/*` for Node 18+ runtimes, but if that was overridden anywhere or if the function targets Node 16 (which still bundles `aws-sdk` v2), that would cause this.

## Findings

### Gap 1 — Bundling regression (severity: critical, current blocker)

The Lambda code shipped to production has a bundling bug that makes the AWS SDK client unusable. Fix the bundler config so AWS SDK modules are marked external. For CDK `NodejsFunction`:

```typescript
new NodejsFunction(this, 'AmiRefreshUpdateLtFn', {
  runtime: Runtime.NODEJS_20_X,  // or 22 — anything that ships SDK v3
  bundling: {
    externalModules: ['@aws-sdk/*'],  // or just leave default; CDK sets this for Node 18+
    minify: true,
    sourceMap: true,  // critical — you'd see real line numbers in this stack trace
  },
  // ...
});
```

`sourceMap: true` would have made this debugging trivial — `r` would be `ec2Client` or whatever the actual variable name is.

### Gap 2 — Pipeline allows broken Lambdas to ship (severity: high, structural)

A Lambda that immediately throws `TypeError` on its handler entry point passed CDK synth, CDK deploy, and made it into the AMI refresh state machine without anyone noticing. Two cheap pre-deploy checks would have caught this:

1. **Smoke-test the Lambda after deploy.** Add a CDK-level CustomResource or a CodePipeline step that does `aws lambda invoke` against the new function with a no-op or canary payload, asserting it returns success. This catches "ships but immediately crashes" failures regardless of cause.

2. **A unit test that imports the bundled output.** If your build produces `dist/index.js`, run `node -e "require('./dist/index.js')"` in CI. The bundle itself loading without throwing wouldn't catch *this* specific bug (the error fires at handler invocation, not module load), but a one-line test that calls the handler with mocked SDK calls would.

### Gap 3 — Step Functions retries hide that this is a deterministic failure (severity: medium, cost + clarity)

The state machine retried the Lambda four times with backoff before failing. For a `TypeError` in the handler — which is by definition deterministic — this is wasted time and money. The retry policy should distinguish between transient errors (`Lambda.ServiceException`, `Lambda.AWSLambdaException`, throttling) and code errors (`Lambda.Unknown`, generic JS errors).

In ASL, this looks like:

```json
"Retry": [
  {
    "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"],
    "IntervalSeconds": 2,
    "MaxAttempts": 6,
    "BackoffRate": 2
  },
  {
    "ErrorEquals": ["TypeError", "ReferenceError", "SyntaxError"],
    "MaxAttempts": 0
  }
]
```

The second clause makes deterministic JS errors fail fast, surfacing the real cause in seconds instead of minutes.

### Gap 4 — `WorkerRefreshFailed` cause string is generic (severity: low, observability)

Same shape as the formatter gaps in the earlier control-plane reports. The Fail state's cause is a static string that points the operator at CloudWatch instead of including the actual error. Capture the Lambda's error payload using `ResultPath: "$.error"` on the Catch and surface it in the cause:

```json
"Catch": [{
  "ErrorEquals": ["States.ALL"],
  "ResultPath": "$.error",
  "Next": "WorkerRefreshFailed"
}],
...
"WorkerRefreshFailed": {
  "Type": "Fail",
  "ErrorPath": "$.error.Error",
  "CausePath": "$.error.Cause"
}
```

Now the Step Functions execution history surfaces the `TypeError` and stack trace directly.

### Gap 5 — Single ASG branch but state machine name implies multiple (severity: low, future-proofing)

The state name `UpdateWorkerTemplates` (plural) and the role split (`role: "workers"` in payload) suggest this state machine was built expecting multiple worker ASGs, but the visible execution only updates one. As your earlier memory notes show migration toward worker ASGs and Cluster Autoscaler, this is going to matter soon. Worth confirming the state machine handles multiple ASGs in parallel (Map state) before you have multiple to refresh — debugging this kind of plurality issue mid-incident is unpleasant.

## What to do, in order

1. Pull the Lambda CloudWatch logs to confirm the exact error line. The TypeError stack should be there in full.
2. Fix the bundling — externalise `@aws-sdk/*`, enable source maps. Redeploy.
3. Re-run the AMI refresh state machine. It should reach the actual instance-refresh logic this time.
4. Add a post-deploy smoke test for this Lambda (Gap 2).
5. Tighten the Step Functions retry policy to fail fast on `TypeError`/`ReferenceError`/`SyntaxError` (Gap 3).
6. Surface real error causes via `ResultPath` + `CausePath` (Gap 4).

The control-plane bootstrap can't move forward until this Lambda works — a successful AMI build that doesn't update the launch template is functionally identical to a failed AMI build. So this is the next blocker after the AMI bake was fixed.

---

## One-line summary

Lambda is shipping with a broken AWS SDK client (almost certainly an esbuild externalisation regression), failing every invocation with `TypeError: r.send is not a function` before it can do any work, and Step Functions is retrying the deterministic failure four times before giving up — fix is to externalise `@aws-sdk/*` in the bundler and enable source maps.