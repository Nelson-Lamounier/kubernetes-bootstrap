---
title: GitHub Branch-Protection Standard (rulesets across all repos)
type: runbook
tags: [github, rulesets, branch-protection, gh-cli, ci, argocd-image-updater, secret-scanning, dependabot]
sources:
  - .github/workflows/ci.yml
  - .github/workflows/promote-to-main.yml
---

# GitHub Branch-Protection Standard

How to bring any repo in this portfolio to the **same** branch-protection posture, and the five
traps that bite when you do it. All commands run from a shell with `gh` authenticated as a repo
**admin** (`gh auth status` shows your login; `gh api repos/<owner>/<repo> --jq .permissions.admin`
returns `true`). Rulesets are edited via the REST API because they are not fully exposed by
`gh`'s porcelain.

> Set once per shell: `R=Nelson-Lamounier/<repo>` — every command below uses `$R`.

## The standard (what every repo should end up with)

| Branch | Rules | Bypass |
| --- | --- | --- |
| **integration** (`develop`, or `main` on single-mainline repos) | `pull_request` (0 approvals) · `required_status_checks` · `deletion` · `non_fast_forward` | repo admin |
| **deploy** (`main`) | same as above | repo admin **+ the bot that writes it** (see Issue 2) |

Fixed choices, applied identically everywhere:

- **0 required approvals.** A solo maintainer cannot approve their own PR; requiring 1 hard-blocks
  every merge (see Issue 4). PR is still *required* — you just merge it yourself.
- **Merge commits allowed** (`allowed_merge_methods: [merge, squash, rebase]`), **no
  `required_linear_history`** — merge commits are kept deliberately for per-commit PR review
  (see Issue 3).
- **`deletion` + `non_fast_forward`** always — no branch deletion, no force-push.
- **Secret scanning + push protection** on (public repos only — see Issue 5).
- **Dependabot security updates** on.

### Current fleet state (2026-07-01)

| Repo | Vis | Required check(s) | main bot bypass |
| --- | --- | --- | --- |
| `kubernetes-bootstrap` | public | 7 named CI jobs | deploy key (Image Updater) |
| `tucaken-infra` | public | `CI Complete` | deploy key + Integration (Image Updater) |
| `ai-applications` | private | `CI Complete` | — (no bot writes its branches) |
| `tucaken-app` | private | `CI Complete` | — |

The check-name difference is not a mistake: see Issue 1.

## Traps index

1. [Requiring conditional CI jobs deadlocks doc-only PRs](#issue-1-requiring-conditional-ci-jobs-deadlocks-doc-only-prs)
2. [Requiring checks on a branch a bot writes to blocks the bot](#issue-2-requiring-checks-on-a-branch-a-bot-writes-to-blocks-the-bot)
3. [`required_linear_history` silently forbids merge commits](#issue-3-required_linear_history-silently-forbids-merge-commits)
4. [404 "Branch not protected" ≠ unprotected; 1 approval locks out a solo dev](#issue-4-branch-not-protected-404-does-not-mean-unprotected-1-approval-locks-out-a-solo-dev)
5. [Secret scanning unavailable on private repos](#issue-5-secret-scanning-unavailable-on-private-repos)
6. [`code_scanning` rule blocks every PR unless the scanner is configured first](#issue-6-code_scanning-rule-blocks-every-pr-unless-the-scanner-is-configured-first)

## Background — rulesets vs. classic protection

GitHub has **two** protection systems on the same branch. "Classic" branch protection
(`/branches/<b>/protection`) and the newer **rulesets** (`/rulesets`). A branch can be fully
protected by a ruleset while classic protection reports it as unprotected. **Always check
rulesets, not just classic protection** (Issue 4).

A ruleset is: a `name`, a `target` (`branch`), `conditions.ref_name.include` (which refs, e.g.
`["refs/heads/main"]` or `["~ALL"]` / `["~DEFAULT_BRANCH"]`), `bypass_actors`, and `rules`.
Multiple rulesets on one ref **union** their rules; a `bypass_actor` only bypasses the rulesets it
is listed in. The effective set is queryable:

```bash
gh api repos/$R/rules/branches/main --jq '[.[].type]|unique'
```

## Applying the standard to a fresh repo

```bash
# One reusable rule block (integration + deploy branches share it)
RULES='[
  { "type": "deletion" }, { "type": "non_fast_forward" },
  { "type": "pull_request", "parameters": {
      "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true,
      "required_review_thread_resolution": true,
      "allowed_merge_methods": ["merge","squash","rebase"] } },
  { "type": "required_status_checks", "parameters": {
      "strict_required_status_checks_policy": false,
      "required_status_checks": [ { "context": "CI Complete" } ] } }
]'
BYPASS='[ { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" } ]'

for br in main develop; do
  echo "{ \"name\": \"$br-pr-protection\", \"target\": \"branch\", \"enforcement\": \"active\",
    \"conditions\": { \"ref_name\": { \"include\": [\"refs/heads/$br\"], \"exclude\": [] } },
    \"bypass_actors\": $BYPASS, \"rules\": $RULES }" > /tmp/rs-$br.json
  gh api -X POST repos/$R/rulesets --input /tmp/rs-$br.json --jq '{id,name,rules:[.rules[].type]}'
done

# Dependabot security updates (works on private repos too)
gh api -X PUT repos/$R/vulnerability-alerts        # 204 = on
gh api -X PUT repos/$R/automated-security-fixes     # 204 = on
```

| Field | Meaning |
| --- | --- |
| `actor_id: 5, actor_type: RepositoryRole` | The built-in **Repository admin** role — lets you (admin) bypass so you're never locked out |
| `bypass_mode: always` | Bypass on both direct pushes and PR merges (vs `pull_request` only) |
| `required_approving_review_count: 0` | PR required, but no second approver needed |
| `strict_required_status_checks_policy: false` | Do **not** force "branch up to date with base" before merge (avoids churn when a bot commits to the base often) |
| `~ALL` / `~DEFAULT_BRANCH` | Ref-name shortcuts: every branch / the default branch |

To **edit** an existing ruleset, get its id and `PUT` the full definition (rulesets replace, not
patch):

```bash
gh api repos/$R/rulesets --jq '.[]|{id,name}'          # find the id
gh api -X PUT repos/$R/rulesets/<id> --input rs.json    # replace it
gh api -X DELETE repos/$R/rulesets/<id>                 # remove a redundant one
```

#### What Success Looks Like

```bash
gh api repos/$R/rules/branches/main    --jq '[.[].type]|unique'
gh api repos/$R/rules/branches/develop --jq '[.[].type]|unique'
# both →  ["deletion","non_fast_forward","pull_request","required_status_checks"]
```

---

## Issue 1: Requiring conditional CI jobs deadlocks doc-only PRs

**Symptom:** A docs-only PR sits `BLOCKED` forever. Its checks show `skipping`, not `pass`/`fail`:

```text
Build TypeScript   skipping
Lint Code          skipping
Type Check         skipping
```

**Root Cause:** The CI (`ci.yml`) uses a `detect-changes` job (`dorny/paths-filter`) and gates the
heavy jobs behind `if: needs.detect-changes.outputs.any-src == 'true'`. On a docs PR those jobs
**skip**. If you mark them as *required* status checks, GitHub waits for a `success` conclusion
that never comes — the skipped job satisfies nothing, so the PR can never merge.

**Fix:** Require the **always-running aggregator**, not the individual jobs. `ci.yml` already ends
with a gate job:

```yaml
# ci.yml
ci-success:
  name: CI Complete           # <-- THIS is the required-check context
  needs: [ ...all jobs... ]
  if: always()                # runs even when upstream jobs skip or fail
  # exits 1 only if a needed job's result == 'failure'; skipped is OK
```

Require the context `"CI Complete"` (as in the `RULES` block above). `kubernetes-bootstrap` is the
exception — its `ci.yml` has **no** aggregator and every job runs unconditionally (no path
filters), so there it is safe to require the 7 job names directly.

**Diagnose — before requiring anything, confirm the CI topology:**

```bash
# Does ci.yml gate jobs on change-detection? (if yes → require the aggregator)
grep -nE "detect-changes|paths-filter|if: needs.detect-changes" .github/workflows/ci.yml
# Is there an always-run gate job? Note its `name:` — that's the check context.
grep -nE "name:|if: always" .github/workflows/ci.yml | grep -i -A0 "complete\|success\|gate"
# What contexts actually reported on a recent PR?
gh pr checks <PR#> --repo $R
```

**Verify:** open a docs-only PR and confirm the required check still turns green.

#### What Success Looks Like

On a docs-only PR: `CI Complete   pass` while `Build TypeScript   skipping`, and
`gh pr view <PR#> --json mergeStateStatus` → `"CLEAN"`.

---

## Issue 2: Requiring checks on a branch a bot writes to blocks the bot

**Symptom:** After tightening `main`, ArgoCD Image Updater's `build: automatic update of <app>`
commits stop landing — the deploy branch silently stalls on an old image tag.

**Root Cause:** `required_status_checks` in a ruleset gates **direct pushes too** ("commits must
be pushed to a ref where the checks pass"), and `pull_request` blocks direct pushes outright.
Image Updater commits **directly** to `main` via its **write-enabled deploy key** (author
`argocd-image-updater`). Under the new rules that push is rejected — and Image Updater fails
silently.

**Fix:** Add the bot as a `bypass_actor` on the `main` ruleset. The actor is the **deploy key**
(and, where present, the **GitHub App integration**), not a user:

```bash
gh api repos/$R/keys --jq '.[]|{id,title,read_only}'    # find the write-enabled key id
```
```json
"bypass_actors": [
  { "actor_id": 5,         "actor_type": "RepositoryRole", "bypass_mode": "always" },
  { "actor_id": <KEY_ID>,  "actor_type": "DeployKey",      "bypass_mode": "always" },
  { "actor_id": <APP_ID>,  "actor_type": "Integration",    "bypass_mode": "always" }
]
```

**Diagnose — always check *who* authors commits on the protected branch before adding rules:**

```bash
# All-time authors — is a bot in the list?
git log --all --format='%an' | sort -u | grep -iE 'argo|image-updater|bot'
# Which branch does the bot write to?
git log --all --author=argocd-image-updater --format='%h %S %s' -3   # %S = the ref
```

Only repos ArgoCD Image Updater writes to need this bypass (`kubernetes-bootstrap`,
`tucaken-infra`). Pure app repos (`ai-applications`, `tucaken-app`) have no bot writing their
branches — admin bypass alone is correct.

#### What Success Looks Like

`git log origin/main --author=argocd-image-updater -1` shows a **recent** auto-update commit dated
*after* the ruleset change — the bot is still writing through.

---

## Issue 3: `required_linear_history` silently forbids merge commits

**Symptom:** A PR that would merge as a merge commit is blocked, or only Squash/Rebase are offered.

**Root Cause:** `required_linear_history` bans merge commits entirely. If you review history by
reading the individual commits inside a merge (the "Merge pull request #N" boundary preserves
them), linear history destroys exactly the structure you want.

**Fix:** Do **not** include the `required_linear_history` rule, and set
`allowed_merge_methods: ["merge","squash","rebase"]` on the `pull_request` rule. Removing the rule
from an existing ruleset is a `PUT` of the full definition minus that rule entry.

#### What Success Looks Like

```bash
gh api repos/$R/rules/branches/main --jq '[.[].type]'   # NO "required_linear_history" in the list
```
The PR's merge dropdown offers "Create a merge commit".

---

## Issue 4: "Branch not protected" (404) does not mean unprotected; 1 approval locks out a solo dev

**Symptom A:**

```text
gh: Branch not protected (HTTP 404)
{"message":"Branch not protected","status":"404"}
```

**Symptom B:** A PR is `BLOCKED` with all checks green and no review requested.

**Root Cause A:** That 404 is from the **classic** protection endpoint
(`/branches/<b>/protection`). The branch can still be fully governed by a **ruleset**, which is a
different API. Reporting "unprotected" off the 404 alone is wrong.

**Root Cause B:** The ruleset's `pull_request` rule has `required_approving_review_count: 1`.
GitHub forbids approving your own PR, so a solo maintainer can never satisfy it — every PR blocks.

**Fix:** Check rulesets, and set approvals to `0`:

```bash
gh api repos/$R/rulesets --jq '.[]|{id,name,enforcement}'          # the real protection
gh api repos/$R/rules/branches/main --jq '[.[].type]|unique'      # effective rules on the ref
```

#### What Success Looks Like

`gh api repos/$R/rulesets` lists an active ruleset even when classic protection 404s, and after
setting approvals to 0 the PR flips to `mergeStateStatus: "CLEAN"`.

---

## Issue 5: Secret scanning unavailable on private repos

**Symptom:**

```text
{"message":"Secret scanning is not available for this repository.","status":"422"}
```

**Root Cause:** Native secret scanning + push protection are **free on public repos**, but on a
**private** repo they require GitHub Advanced Security / "Secret Protection" — purchasable only on
**Team or Enterprise** plans (billed per active committer), *not* on GitHub Pro. The `$5/mo`
personal plan does not include it.

**Fix (private repo):** you cannot pre-enable it. Either rely on a third-party scanner already
running on your PRs (e.g. GitGuardian shows as a `GitGuardian Security Checks` check), or enable
GitHub-native scanning the moment the repo goes **public** — the same PATCH returns `200` once
public:

```bash
gh api -X PATCH repos/$R \
  -f 'security_and_analysis[secret_scanning][status]=enabled' \
  -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
```

#### What Success Looks Like

```bash
gh api repos/$R --jq '{ss:.security_and_analysis.secret_scanning.status, pp:.security_and_analysis.secret_scanning_push_protection.status}'
# public repo → {"ss":"enabled","pp":"enabled"}
```

---

## Issue 6: `code_scanning` rule blocks every PR unless the scanner is configured first

**Symptom:** A `code_scanning` rule is on `main`, but PRs only merge when an **admin** merges them; a
non-admin PR shows a required check that never resolves:

```text
Code scanning results for CodeQL are required and still pending
```

Or, subtler: the rule "works" for months only because the sole maintainer is an admin bypass actor
— the gate has never actually run.

**Root Cause:** The `code_scanning` rule requires a **result** from a named tool (e.g. CodeQL) below
the alert thresholds. It does **not** enable the tool. If CodeQL isn't configured, no result is ever
produced, so nothing satisfies the rule — every non-bypass merge is blocked. This is exactly the
state `frontend-portfolio` was in: the rule required CodeQL while
`code-scanning/default-setup` was `not-configured` and there were **zero analyses**.

**Fix — two ordered steps (order matters):**

```bash
# STEP 1: enable the scanner FIRST. Default setup runs CodeQL on push/PR/weekly,
# no workflow file needed. Free on public repos (uses Actions minutes).
gh api -X PATCH repos/$R/code-scanning/default-setup -f state=configured -f query_suite=default
#   -> returns {"run_id":...}; an initial analysis on the default branch starts immediately.

# STEP 2: only after a baseline analysis exists, add the rule (append to the main ruleset).
CS='{type:"code_scanning",parameters:{code_scanning_tools:[{tool:"CodeQL",alerts_threshold:"errors",security_alerts_threshold:"high_or_higher"}]}}'
gh api repos/$R/rulesets/<MAIN_RULESET_ID> --jq "{name,target,enforcement,conditions,bypass_actors, rules:(.rules + [$CS])}" > rs.json
gh api -X PUT repos/$R/rulesets/<MAIN_RULESET_ID> --input rs.json
```

| Parameter | Meaning |
| --- | --- |
| `query_suite: default` | The standard CodeQL query pack (vs `extended` — more queries, more noise/time) |
| `alerts_threshold: errors` | Block merge on `error`-level code-quality alerts (not warnings/notes) |
| `security_alerts_threshold: high_or_higher` | Block merge on high/critical security alerts only |

**Gotcha — pre-existing open PRs:** default setup runs CodeQL on **new** push/PR events, so a PR
opened *before* you enabled it has no CodeQL result on its head and will sit blocked. Re-trigger it
(push any commit, or close/reopen), or merge via admin bypass. New PRs run it automatically.

**Diagnose:**

```bash
gh api repos/$R/code-scanning/default-setup --jq '{state,query_suite}'   # "not-configured" = tool off
gh api "repos/$R/code-scanning/analyses?per_page=3" --jq '[.[].tool.name]|unique'  # which tools ran
gh api repos/$R/rulesets/<id> --jq '.rules[]|select(.type=="code_scanning").parameters'  # rule present?
```

**Verify:** a CodeQL analysis exists on the default branch and the rule is live.

#### What Success Looks Like

```bash
gh api "repos/$R/code-scanning/analyses?per_page=1" --jq '.[0]|{tool:.tool.name, ref}'
#   -> {"tool":"CodeQL","ref":"refs/heads/main"}
gh api repos/$R/rules/branches/main --jq '[.[].type]|index("code_scanning")!=null'   # -> true
```

Then check **Security → Code scanning** in the UI once: a baseline `error`/`high+` finding will
(correctly) block merges until resolved or dismissed — that is the gate working.

---

## Common verification commands

```bash
gh api repos/$R/rulesets --jq '.[]|{id,name,enforcement}'                       # what protects this repo
gh api repos/$R/rules/branches/main    --jq '[.[].type]|unique'                # effective rules on main
gh api repos/$R/rules/branches/develop --jq '[.[].type]|unique'                # effective rules on develop
gh api repos/$R --jq '.security_and_analysis'                                   # secret scanning / dependabot
gh api repos/$R/vulnerability-alerts -i | head -1                              # 204 = dependabot on, 404 = off
gh pr view <PR#> --repo $R --json mergeStateStatus,mergeable                    # is a PR actually mergeable
git log --all --format='%an' | sort -u | grep -iE 'argo|bot'                   # does a bot write here?
```

## Glossary

| Term | Meaning |
| --- | --- |
| **Ruleset** | Modern per-branch protection object (`/rulesets`); unions with any other ruleset on the same ref. Replaces classic branch protection. |
| **Classic protection** | Legacy `/branches/<b>/protection` API; returns `404 Branch not protected` when only a ruleset (not classic) governs the branch. |
| **`bypass_actor`** | Who may skip a ruleset's rules. Types: `RepositoryRole` (id 5 = admin), `Team`, `Integration` (a GitHub App), `DeployKey`. Only bypasses the ruleset it's listed in. |
| **`required_status_checks`** | Named CI contexts that must pass; gates direct pushes as well as PR merges. |
| **`strict` policy** | When true, the branch must be up to date with its base before merge. Kept `false` here so frequent bot commits to the base don't churn open PRs. |
| **`CI Complete`** | The `name:` of the `ci-success` aggregator job (`if: always()`) — the stable, always-reported check to require when CI gates jobs behind change-detection. |
| **Aggregator / gate job** | A final CI job that `needs` all others and fails only on a real failure; safe to require because it always reports even when upstream jobs skip. |
| **`dorny/paths-filter`** | Action used by `detect-changes` to decide which jobs run based on changed paths — the reason heavy jobs `skip` on docs PRs. |
| **Image Updater writeback** | ArgoCD Image Updater commits new image tags directly to the deploy branch via a write-enabled deploy key (author `argocd-image-updater`); needs a ruleset bypass. |
| **GHAS** | GitHub Advanced Security — gates private-repo secret scanning; Team/Enterprise only, per-committer billing. |
| **`code_scanning` rule** | Ruleset rule requiring a code-scanning *result* below set thresholds. Requires the tool (CodeQL/checkov) to actually run — enabling the rule does not enable the tool. |
| **CodeQL default setup** | GitHub-managed code scanning: `code-scanning/default-setup` state `configured` runs CodeQL on push/PR/weekly with no workflow file. Free on public repos. |
| **`alerts_threshold` / `security_alerts_threshold`** | The severity floors at which the `code_scanning` rule blocks a merge (e.g. `errors` / `high_or_higher`). |
