# CODE_REVIEW.md Template

Use this structure in consumer repositories.

```md
# Project Code Review Standards

### [CR-001] Example standard title
- required: true
- applies_when: always
- pass_criteria: Describe exact project-specific rule.
- evidence_required: What proof reviewer must cite.

### [CR-002] Example conditional standard
- required: true
- applies_when: only when migrations are present
- pass_criteria: Explain expected migration safety behavior.
- evidence_required: Mention file + line and why requirement passes/fails.
```

Notes:
- IDs inside `[]` are mandatory and must be unique.
- `required: true` standards are merge-blocking.
- The workflow evaluates only what is listed in `CODE_REVIEW.md`.
