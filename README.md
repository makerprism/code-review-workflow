# Review Agent Code Review Workflow

Reusable GitHub workflow for strict, project-specific PR gating based on `CODE_REVIEW.md`.

It labels PRs with:
- `review:approved`
- `review:changes-requested`

and publishes a required check-run (default: `Review Agent Code Review`).

## How It Works

1. Consumer repo triggers `pull_request_target`.
2. This reusable workflow reads `CODE_REVIEW.md` from the base branch.
3. It fetches PR diff metadata via GitHub API (no PR code execution).
4. It runs your Review Agent/OpenCode command.
5. It validates the JSON response outside the agent and applies deterministic pass/fail rules.

## Consumer Setup

Add `.github/workflows/review-agent.yml` to the consumer repo:

```yaml
name: Review Agent Review

on:
  pull_request_target:
    types: [opened, synchronize, reopened, ready_for_review]

jobs:
  review-agent:
    uses: makerprism/code-review-workflow/.github/workflows/review-agent.yml@v1
    permissions:
      contents: read
      checks: write
      pull-requests: write
      issues: write
      packages: read
    secrets: inherit
    with:
      code_review_path: CODE_REVIEW.md
      workflow_ref: v1
```

By default the reusable workflow runs `./scripts/run-review-agent.sh` from this repository.
You can override it with `review_agent_command` if needed.

`review_agent_command` must print one JSON object to stdout matching `workflows/review-agent/review-result.schema.json`.
The command receives these env vars:
- `REVIEW_AGENT_PROMPT_FILE`
- `REVIEW_AGENT_CONTEXT_FILE`
- `REVIEW_AGENT_OUTPUT_SCHEMA_FILE`

Optional env vars for the default runner script:
- `REVIEW_AGENT_MODEL`
- `REVIEW_AGENT_OPENCODE_EXTRA_ARGS`

## Required CODE_REVIEW.md Format

Use `### [ID] Title` headings and key/value fields:

```md
### [CR-001] Constraint title
- required: true
- applies_when: always
- pass_criteria: Your project-specific rule.
- evidence_required: What evidence must be cited.
```

Only standards listed there are evaluated.

## Security Model

- Intended for `pull_request_target`.
- Do not execute PR head code.
- Review payload is built from GitHub API data and base-branch files.
- Keep permissions minimal.

## Inputs

- `code_review_path` (default `CODE_REVIEW.md`)
- `review_agent_command` (default `./scripts/run-review-agent.sh`)
- `check_name` (default `Review Agent Code Review`)
- `max_files` (default `120`)
- `max_patch_chars` (default `300000`)
- `fail_on_error` (default `true`)
- `allow_required_not_applicable` (default `false`)
- `workflow_ref` (default `main`)

## Versioning

Tag stable releases and reference `@v1` from consumer repos.
