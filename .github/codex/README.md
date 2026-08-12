# Codex daily discovery workflow

The `Codex daily discovery` workflow performs a focused repository review and publishes non-duplicate findings as GitHub issues.

## What it reviews

The workflow prioritizes:

1. Bugs and correctness risks.
2. Potential security problems.
3. Technical debt with a concrete maintenance or reliability impact.
4. At most one small product improvement per daily run.

Product suggestions must be narrow improvements to an existing Tokia workflow. Large features, integrations, platform changes, and broad redesigns are out of scope.

## Model usage gate

The workflow first runs a deterministic preflight step. Codex is invoked only when at least one of these signals is present:

- a commit landed in the last 24 hours;
- a workflow failed in the last 24 hours;
- a code scanning alert changed in the last 24 hours;
- a Dependabot alert changed in the last 24 hours;
- the daily product-improvement review is due;
- the workflow was manually forced.

The gate does not consume OpenAI model tokens.

## Setup

Add an `OPENAI_API_KEY` repository secret under **Settings → Secrets and variables → Actions**. The key is used only by the Codex analysis job.

The publishing job creates the required labels if they do not already exist:

- `source:codex`
- `status:proposed`
- `status:accepted`
- `status:in-development`
- `type:bug`
- `type:security`
- `type:tech-debt`
- `type:product`
- `priority:high`
- `priority:medium`
- `priority:low`

The workflow does not modify repository files, create branches, or open pull requests.

## Issue comments

The `Codex issue assistant` workflow listens for newly created comments on issues. A trusted repository maintainer can invoke it with:

```text
/codex
What is the smallest safe fix for this issue?
```

The command must start the comment. Comments from bots, external contributors, pull requests, and untrusted accounts are ignored. The workflow reads the issue and its recent comment thread, runs Codex with read-only repository access, and posts the answer back to the issue.

Responses are deduplicated by the triggering comment ID. The workflow uses one concurrency group per issue, so only one response for a given issue runs at a time while different issues can be handled independently. To avoid replacing a pending command, wait for the current `/codex` response before posting another command on the same issue.

## Model routing

The high-volume workflows use `gpt-5.6-luna` with low reasoning effort to reduce cost while handling deterministic discovery and concise issue responses. The issue implementation workflow uses `gpt-5.6-terra` with medium reasoning effort because it must inspect the repository, modify code, run checks, and produce a validated commit plan. These settings are declared directly in each workflow's `openai/codex-action` step.

## Issue implementation

The `Codex issue implementation` workflow starts when a maintainer adds `status:accepted` to an open issue carrying the `source:codex` label. It changes the issue to `status:in-development`, prepares a branch named `codex/issue-N`, and gives Codex workspace-write access to implement only that issue.

Codex must create a focused implementation plan, run the relevant checks, and leave no unrelated changes. The final response is structured JSON containing ordered commit groups, exact file lists, conventional commit messages, expected-failure metadata for test-first commits, checks, and limitations. The host runner validates that plan and creates the commits outside the Codex sandbox, preserving independent boundaries such as tests, backend code, frontend behavior, configuration, and documentation. The workflow pushes the branch and opens a pull request against `master` only when implementation commits exist. Implementations run one at a time across issues, and GitHub keeps at most one pending run per concurrency group. Accept issues sequentially: if a third issue is accepted before the active and pending work finish, GitHub may replace the older pending run. This workflow intentionally does not provide a durable queue.

If implementation produces no commits or fails before a pull request is opened, an open issue is returned to `status:proposed` and receives a diagnostic comment. Closed issues keep their current labels.

## Schedule and testing

The scheduled run is configured for 06:17 in `America/Montevideo`. Scheduled workflows use the latest commit on the default branch, so the workflow must be merged before the daily schedule can run.

Use **Actions → Codex daily discovery → Run workflow** to test it manually. Enable `force` to invoke Codex even when the deterministic gate finds no new signal.
