---
name: git-commit
description: >
  Use this skill whenever committing code to git/GitHub. Triggers on any request
  involving git commit, push, staging changes, or wrapping up a task with version
  control. Enforces: tests pass, lint passes, atomic descriptive commits, no
  "Claude" authorship identity. Also applies during implementation planning —
  every planned commit must follow this protocol.
---

# Git Commit Skill

This skill governs every interaction with git. It applies at two moments:

1. **During implementation planning** — when breaking down a task into steps, every step that ends in a commit must reference this skill and follow its rules.
2. **At commit time** — before any `git commit` is executed, this checklist runs in full, no exceptions.

---

## Pre-Commit Checklist (run in order, stop on failure)

### 1. Run Tests

```bash
# Detect and run the appropriate test command
# Check package.json scripts first
npm test         # or: yarn test / pnpm test
# For monorepos, scope to changed packages only
```

- **Tests must pass.** If any test fails, stop. Do not commit. Fix the failure first.
- Never use `--passWithNoTests` or equivalent flags to suppress failures.
- Never skip tests with comments like "tests not critical for this change."
- If there are no tests for a new feature, note it explicitly to the user and ask whether to add them before committing.

### 2. Run Lint

```bash
# Detect and run the appropriate lint command
npm run lint       # or: yarn lint / pnpm lint
# For TypeScript projects also run type-check
npm run typecheck  # or: tsc --noEmit
```

- **Lint must pass with zero errors.** Warnings are acceptable only if they existed before the change.
- Never use `--max-warnings=9999` or `eslint-disable` comments to silence new lint errors unless the user explicitly approves the suppression with a reason.
- Fix lint errors before committing. Do not commit lint-failing code.

### 3. Scope and Stage Changes Atomically

Before staging, review all changed files:

```bash
git status
git diff
```

**Group changes by logical unit.** If the diff touches multiple concerns (e.g. a feature + a bug fix + a refactor), split them into separate commits. Each commit should answer: *"What is the single thing this commit does?"*

Rules for splitting:
- Feature code + its tests → one commit
- Dependency updates → separate commit
- Config/infra changes → separate commit from application logic
- Bug fixes unrelated to the current feature → separate commit
- Refactors with no behavior change → separate commit

Stage only the files for the current logical unit:

```bash
git add <specific-files>
# or interactively
git add -p
```

Never use `git add .` across a mixed-concern diff.

---

## Commit Message Format

Use the **Conventional Commits** specification:

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

### Type (required)

| Type | When to use |
|------|-------------|
| `feat` | New feature or capability |
| `fix` | Bug fix |
| `refactor` | Code change with no behavior change |
| `test` | Adding or updating tests only |
| `chore` | Build, tooling, dependency changes |
| `docs` | Documentation only |
| `ci` | CI/CD pipeline changes |
| `perf` | Performance improvement |
| `style` | Formatting, whitespace (no logic change) |

### Scope (recommended)

Use the affected module, package, or layer. Examples: `api`, `auth`, `k8s`, `cdk`, `ui`, `monitoring`, `argocd`.

### Summary line rules

- **Imperative mood**: "add feature" not "added feature" or "adding feature"
- **Lowercase** after the colon
- **No period** at the end
- **50 characters max** for the summary line
- Be specific: `fix(traefik): correct middleware namespace reference` not `fix bug`

### Body (use when the summary line is not enough)

- Wrap at 72 characters
- Explain **what** changed and **why**, not how (the code shows how)
- Reference issue numbers if applicable: `Closes #42`

### Examples

```
feat(argocd): add CI token rotation via GitHub Actions secret

Automates ArgoCD token refresh on a 30-day schedule using a
dedicated GitHub Actions workflow. Removes the need for manual
kubectl secret patching.

Closes #87
```

```
fix(traefik): resolve cross-namespace middleware rejection in v3

Traefik v3 removed implicit cross-namespace middleware access.
Added explicit namespace annotation to all IngressRoute resources
and updated middleware references to use FQDN format.
```

```
chore(deps): upgrade aws-cdk-lib to 2.130.0
```

---

## Identity Rules

- **Never commit as "Claude"** or any AI-generated identity.
- Verify git identity before the first commit in any session:
  ```bash
  git config user.name
  git config user.email
  ```
- If the identity is missing, blank, or set to "Claude" / "assistant" / any non-human placeholder, stop and ask the user to confirm their name and email before proceeding.
- Do not set `user.name` or `user.email` on behalf of the user without explicit confirmation of the values.

---

## Multi-Commit Workflow (large changesets)

When a task produces a large diff spanning multiple concerns, follow this sequence:

1. Run `git status` and `git diff` to get the full picture.
2. Identify logical groupings (feature, fix, refactor, config, tests, deps).
3. Present the proposed commit plan to the user before executing:

   ```
   Proposed commits:
   1. chore(deps): upgrade eslint and typescript-eslint
   2. refactor(api): extract request validation middleware
   3. feat(api): add /health endpoint with readiness probe
   4. test(api): add integration tests for /health endpoint
   5. ci: add health check step to GitHub Actions workflow
   ```

4. Get confirmation, then execute each commit in sequence — running tests and lint before each one.
5. Do not squash all changes into one commit to save time.

---

## Implementation Planning Reference

When planning a multi-step implementation (e.g. responding to "build X" or "implement Y"), structure the plan so each milestone ends with a git-commit step that explicitly follows this skill.

Example plan structure:

```
Step 1: Scaffold the new module
  → commit: feat(<scope>): scaffold <module> with initial structure [git-commit skill]

Step 2: Implement core logic
  → commit: feat(<scope>): implement <feature> logic [git-commit skill]

Step 3: Add tests
  → commit: test(<scope>): add unit tests for <feature> [git-commit skill]

Step 4: Wire into existing system
  → commit: refactor(<scope>): integrate <feature> into <system> [git-commit skill]
```

The `[git-commit skill]` tag is a reminder that the full pre-commit checklist (tests, lint, atomic staging, identity check) applies at that step — not just the message format.

---

## Gotchas

- **Monorepos**: Scope lint and tests to affected packages where possible to keep feedback loops fast. But never skip the check entirely.
- **Generated files**: Do not commit auto-generated files (e.g. `dist/`, `*.js` compiled from `*.ts`, CDK `cdk.out/`) unless they are intentionally tracked. Check `.gitignore` first.
- **Lock files**: Always commit `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` together with the dependency change that caused it — never in isolation, never omitted.
- **Secrets**: Before staging, scan for accidental inclusion of `.env` files, AWS credentials, tokens, or private keys. Stop and alert the user if found.
- **Empty commits**: Never use `git commit --allow-empty`.
- **Force push**: Never `git push --force` to a shared or main branch without explicit user instruction.