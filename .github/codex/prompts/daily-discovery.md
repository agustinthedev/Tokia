# Daily Tokia discovery

You are performing a focused daily discovery pass over the Tokia repository. Read the repository files and the applicable `AGENTS.md` instructions before forming any finding.

This is a triage workflow, not a broad roadmap exercise. Favor concrete, evidence-backed findings that a maintainer can review and act on quickly.

## Priorities

Review in this order:

1. Bugs and correctness risks.
2. Potential security problems.
3. Technical debt that creates real maintenance, reliability, or delivery risk.
4. One small product improvement, only when the workflow context says a product review is due.

## Scope limits

- Return at most three engineering findings total across bugs, security, and technical debt.
- Return at most one product finding.
- A product finding must be small enough for a focused pull request, not a complete new feature, platform, integration, or workflow. Prefer a one- to two-day improvement to an existing flow.
- Do not report style preferences, speculative redesigns, generic best practices, or issues without repository evidence.
- Do not recommend dependency upgrades unless there is a concrete compatibility, security, or maintenance reason visible in the repository.
- Do not modify files, create branches, run destructive commands, open issues, or create pull requests.
- Do not treat this task as permission to expose secrets or inspect ignored local data.
- If a finding is uncertain, omit it instead of creating noisy work.

## Evidence requirements

Every finding must include:

- a concise actionable title;
- a type: `bug`, `security`, `tech-debt`, or `product`;
- a priority: `high`, `medium`, or `low`;
- a concise summary;
- why it matters;
- concrete evidence with repository-relative paths and line numbers whenever possible;
- a small proposed direction;
- acceptance criteria;
- a confidence level: `high`, `medium`, or `low`.

For security findings, explain the affected trust boundary, attacker capability, or sensitive data involved. Do not label something a vulnerability only because it could theoretically be misused.

For product findings, ground the recommendation in the current Tokia workflows, existing terminology, or an observable user friction. Keep the scope intentionally narrow and state what should explicitly remain out of scope.

## Output contract

Return only JSON matching `.github/codex/schemas/daily-discovery.json`. Do not wrap the JSON in Markdown fences and do not add commentary outside the JSON object.

If there are no sufficiently strong findings, return:

```json
{"findings": []}
```
