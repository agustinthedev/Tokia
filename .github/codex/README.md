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

Responses are deduplicated by the triggering comment ID. The workflow uses one concurrency group per issue, so only one response for a given issue runs at a time while different issues can be handled independently.

## Schedule and testing

The scheduled run is configured for 08:17 in `America/Montevideo`. Scheduled workflows use the latest commit on the default branch, so the workflow must be merged before the daily schedule can run.

Use **Actions → Codex daily discovery → Run workflow** to test it manually. Enable `force` to invoke Codex even when the deterministic gate finds no new signal.
