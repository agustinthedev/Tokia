# AGENTS.md

## Repository scope

This file applies to the **Tokia** repository only.

The repository name is:

`Tokia`

All implementation work, Git operations, branches, commits, pushes, pull
requests, issue references, and repository-related actions performed under
these instructions must target the Tokia repository.

Do not make changes to any other repository, even if GitHub credentials,
connections, local clones, or tooling provide access to additional
repositories.

Do not create branches, commits, pull requests, issues, releases, tags, or
other GitHub resources in repositories other than Tokia unless the user
explicitly instructs you to do so in the current task.

Before performing any remote Git or GitHub operation, verify that the target
repository is Tokia.

If the configured remote unexpectedly points to another repository, stop that
remote operation and report the mismatch rather than pushing or creating a pull
request in the wrong repository.

Repository access does not imply permission to modify other accessible
repositories.

---

## General workflow

When making changes to this repository, work autonomously and complete the
entire development workflow unless explicitly instructed otherwise.

Before modifying code:

1. Confirm that the current repository is Tokia.
2. Inspect the repository and understand the relevant existing architecture.
3. Check the current Git status and current branch.
4. Inspect recent commits when they are relevant to understanding ongoing work.
5. Ensure unrelated existing changes are preserved.
6. Fetch the latest remote state when network access is available.

Do not begin implementation without first understanding the relevant existing
code and repository structure.

---

## Autonomous execution

Do not stop after producing a plan.

After understanding the task, proceed with implementation unless there is a
genuine blocker that cannot reasonably be resolved from:

* the repository;
* existing documentation;
* tests;
* configuration;
* existing implementation patterns;
* available tooling.

Prefer inspecting the codebase and making reasonable engineering decisions over
asking unnecessary clarification questions.

When encountering an issue:

1. Investigate it.
2. Identify the root cause.
3. Determine whether it is part of the requested task.
4. Implement the appropriate fix when it is in scope.
5. Validate the fix.
6. Continue with the original task.

Do not stop at the first error if the error can reasonably be diagnosed and
resolved.

Do not leave obvious TODOs, placeholders, partial implementations, mocked logic,
or unfinished work when the functionality can reasonably be completed during
the current task.

If multiple reasonable implementation approaches exist, prefer the one that:

1. best matches the existing architecture;
2. introduces the least unnecessary complexity;
3. preserves existing behavior;
4. is easiest to maintain;
5. can be properly tested.

A task is not complete simply because the requested code has been written.
Implementation must also be validated and integrated through the repository's
normal Git workflow.

---

## Existing work

Before modifying anything, inspect:

* `git status`;
* the current branch;
* recent commits when relevant;
* staged changes;
* unstaged changes;
* untracked files;
* the relevant existing implementation.

Assume that pre-existing changes may belong to the user, another developer, or
another agent.

Never overwrite, discard, reset, revert, rewrite, or otherwise destroy existing
work unless explicitly instructed.

If unrelated uncommitted changes exist:

1. Preserve them.
2. Do not include them in commits for the current task.
3. Do not reformat or modify those files unless required by the requested work.
4. Avoid commands that could affect them.
5. Clearly distinguish new task changes from pre-existing work.

Do not assume that an uncommitted change is disposable merely because it is not
part of a commit.

Do not use destructive Git commands such as:

* `git reset --hard`
* `git clean -fd`
* `git checkout -- <file>`
* `git restore <file>`
* forced branch resets

when they could discard existing work.

If one of those operations is genuinely required, do not perform it unless the
user has explicitly authorized destruction of the affected changes.

Do not amend, squash, rebase, reorder, or rewrite commits created by the user or
another agent unless explicitly instructed.

Do not modify unrelated files simply to make the working tree cleaner.

If the current branch already contains unrelated work, avoid mixing the new
task into that work when reasonably possible.

When safe and practical, create the task branch from the appropriate up-to-date
`master` branch without disturbing existing local changes.

If existing local work makes that unsafe, preserve the work and choose the
least destructive approach.

Never delete or overwrite user-created files merely because they appear unused,
temporary, experimental, or inconsistent with the current implementation.

---

## Git workflow

The primary branch for this repository is:

`master`

Never implement feature work directly on `master`.

Before making changes:

1. Confirm the repository is Tokia.
2. Check the current Git status.
3. Check the current branch.
4. Fetch the latest remote state when possible.
5. Start from the latest appropriate `master`.
6. Create a dedicated branch for the task.

Use descriptive branch names.

Examples:

* `feat/add-clipping-workflow`
* `fix/video-processing-timeout`
* `refactor/provider-abstraction`
* `chore/update-dependencies`

Do not reuse an unrelated feature branch for new work.

Do not push implementation commits directly to `master`.

---

## Commits

Commit structure is part of the definition of done, not a stylistic
preference. Before implementation, outline the intended commit sequence and
keep each commit focused on one coherent concern. A commit should be easy to
review, revert, cherry-pick, and describe in one sentence.

Do not put an entire feature or bug fix into one commit when it contains
multiple independently understandable concerns. In particular, do not combine
the production fix, regression-test changes, unrelated frontend work,
refactors, formatting, documentation, or configuration changes in the same
commit merely because they are part of one pull request.

For a bug fix, separate the regression coverage from the production fix when
they can be separated. A typical sequence is:

1. `test(scope): add regression coverage for the reported behavior`;
2. `fix(scope): implement the smallest production change that fixes it`;
3. optional follow-up commits for independent UI, refactoring, documentation,
   or configuration work.

If a test-first commit is expected to fail until the following fix commit,
make that intent clear in the commit and pull request; do not merge the test
and implementation solely to avoid an intermediate red commit. Every commit
must still be understandable and should leave the repository in a safe,
recoverable state whenever practical.

The merged [PR #10](https://github.com/agustinthedev/Tokia/pull/10), titled
`fix: restore video source duration in slideshow trim`, is an example of what
to avoid: its single commit mixed API changes, frontend behavior, styling, and
test changes. A similar task should instead use separate logical commits such
as regression coverage, API/source-duration correction, and independent
frontend interaction changes. These are logical boundaries, not a rule to
split every changed file into its own commit.

Good commit boundaries may include:

* database/schema changes;
* backend implementation;
* frontend implementation;
* integration work;
* tests;
* configuration;
* documentation.

Do not create a separate commit merely because a single file changed. Commit
according to logical units of work, and do not combine unrelated concerns just
to reduce the number of commits.

Use clear commit messages following this general format:

`type(scope): short description`

Examples:

`feat(clipping): add topic extraction pipeline`

`fix(api): handle missing provider credentials`

`test(projects): add project creation integration tests`

`refactor(storage): isolate temporary media handling`

Avoid meaningless commit messages such as:

* `work`
* `changes`
* `updates`
* `stuff`
* `fix`
* `wip`

unless explicitly requested.

Do not unnecessarily rewrite or squash previous commits during normal
implementation.

---

## Scope discipline

Only change files that are necessary or reasonably related to the requested
task.

Do not perform unrelated:

* refactors;
* dependency upgrades;
* formatting sweeps;
* renames;
* architectural migrations;
* cleanup work

unless they are required for the requested functionality.

If you discover an unrelated issue, do not expand the task automatically unless
the issue blocks the requested work or presents a significant correctness or
security problem.

Preserve existing behavior unless the requested task intentionally changes it.

Follow existing patterns and conventions before introducing new abstractions.

Avoid adding complexity for hypothetical future requirements that are not part
of the current task.

---

## Dependencies

Before adding a new dependency:

1. Determine whether the functionality can reasonably be implemented using
   existing dependencies or platform capabilities.
2. Check whether the repository already contains an equivalent utility.
3. Prefer mature and actively maintained dependencies when a dependency is
   justified.

Do not introduce large frameworks or infrastructure for small problems.

Do not upgrade unrelated dependencies unless necessary.

---

## Testing and validation

Before considering a task complete, run the relevant validation available in
the repository.

Depending on the project, this may include:

1. Automated tests.
2. Integration tests.
3. Linting.
4. Formatting checks.
5. Type checking.
6. Build or compilation checks.
7. Relevant end-to-end tests.
8. Focused manual verification when automation is unavailable.

Prioritize tests that exercise the changed functionality.

Fix failures caused by the implementation.

Do not silently ignore failing tests.

If pre-existing tests fail for reasons unrelated to the current task:

1. verify that they are unrelated;
2. do not hide the failure;
3. clearly report it in the final summary.

If a validation step cannot be executed because of an environment, dependency,
credential, network, hardware, or permission limitation, clearly report the
limitation.

Never claim that a test passed unless it was actually executed successfully.

---

## Debugging

When functionality does not behave as expected, investigate the root cause
rather than applying speculative patches.

Use available evidence such as:

* logs;
* stack traces;
* tests;
* runtime output;
* existing code paths;
* API responses;
* persisted state.

Avoid repeatedly applying unrelated changes hoping that one resolves the issue.

When possible, reproduce a bug before fixing it and verify the same reproduction
case after the fix.

Remove temporary debugging code, logs, test fixtures, and generated artifacts
before completing the task unless they are intentionally useful to the project.

---

## Documentation

Update documentation when the change affects:

* setup instructions;
* configuration;
* environment variables;
* public APIs;
* architecture;
* operational procedures;
* user-visible behavior.

Do not duplicate detailed project documentation inside `AGENTS.md`.

When deeper project context is required, prefer dedicated documentation files
such as:

* `README.md`
* `docs/ARCHITECTURE.md`
* `docs/PRODUCT.md`
* `docs/DEVELOPMENT.md`
* other relevant files under `docs/`

Read relevant project documentation before making decisions that depend on it.

---

## Security and sensitive data

Never commit:

* API keys;
* access tokens;
* passwords;
* private credentials;
* secrets;
* private certificates;
* local `.env` values;
* other sensitive information.

Before committing or pushing, inspect the diff for accidental secrets or local
configuration.

Respect existing `.gitignore` rules.

Do not weaken authentication, authorization, validation, or security controls
unless the task explicitly requires a security-related change and the
implications are understood.

---

## Generated and temporary files

Do not commit temporary or generated artifacts unless the repository
intentionally tracks them.

Examples include:

* temporary downloads;
* logs;
* local databases;
* caches;
* test output;
* screenshots created for debugging;
* generated media;
* build artifacts;
* local IDE configuration.

If a tool creates temporary files during implementation, clean them up before
completion when appropriate.

---

## Final review

Before pushing changes:

1. Confirm the target repository is Tokia.
2. Review `git status`.
3. Review the final diff.
4. Confirm that changes match the requested scope.
5. Confirm unrelated existing work was not included.
6. Confirm there are no obvious debugging remnants.
7. Confirm no secrets or credentials are included.
8. Confirm temporary files were not accidentally added.
9. Run the relevant validation.
10. Commit any remaining intentional changes.

If the final diff reveals an obvious mistake, fix it before pushing.

---

## Push workflow

After implementation and validation:

1. Confirm the remote repository is Tokia.
2. Ensure all intentional task changes are committed.
3. Push the task branch to the configured Tokia remote repository.

Never force-push unless explicitly requested.

Never push task implementation directly to `master`.

Never push to another repository simply because the current GitHub connection
has access to it.

If pushing is impossible because of permissions, authentication, connectivity,
repository mismatch, or environment restrictions, clearly report that fact.

Do not claim the branch was pushed unless the push actually succeeded.

---

## Pull requests

After successfully pushing the task branch, create a pull request in the
**Tokia** repository targeting:

`master`

when repository access, GitHub tooling, and environment permissions allow it.

Before creating the pull request, verify:

* repository: Tokia;
* source branch: the task branch;
* target branch: `master`.

Do not create the pull request in any other accessible repository.

Do not merge the pull request unless explicitly instructed.

Unless the user explicitly instructs otherwise, when the requested work is
complete, all intentional changes have been committed, and validation has
finished, create the pull request as **ready for review**. Do not create it as
a draft. Create a draft pull request only when the user explicitly requests
that state. If the work is not ready, continue working or report the blocker
instead of presenting an incomplete change as ready.

Use a clear PR title describing the outcome of the change.

The PR description should normally contain:

### Summary

A concise explanation of what was changed and why.

### Changes

The important implementation changes.

### Validation

Tests, builds, checks, or manual verification performed.

### Notes

Known limitations, migrations, operational considerations, or relevant
follow-up work, if any.

If the environment does not allow PR creation, report that explicitly and
provide enough information for the PR to be created manually.

---

## Completion criteria

A task is not considered complete merely because code was written.

Unless prevented by a genuine environment or permission limitation, complete
the entire workflow:

`inspect → implement → validate → review diff → commit → push → pull request`

Before finishing, verify that:

* the work was performed in the Tokia repository;
* the requested functionality is implemented;
* relevant tests or checks have been run;
* the implementation does not contain known obvious regressions;
* unrelated existing work was preserved;
* intentional task changes are committed;
* the task branch has been pushed;
* a pull request targeting `master` in Tokia has been created when possible.

---

## Final report

At the end of the task, provide a concise implementation report containing:

* what was implemented;
* repository used;
* branch name;
* commits created;
* tests/checks executed and their results;
* push status;
* pull request URL, if created;
* any unresolved issues or limitations.

Distinguish clearly between:

* work that was successfully completed;
* work that could not be performed because of environment or permission
  limitations;
* optional follow-up work.

Do not describe something as completed if it was not actually completed.
