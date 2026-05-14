# Local Issues

This directory keeps local repository issues: decisions, open questions, design
tradeoffs, and work items that should be preserved in Git but do not need
GitHub Issues yet.

Use date-prefixed Markdown files:

```text
YYYY-MM-DD-topic.md
```

Use small YAML frontmatter for searchable metadata:

```markdown
---
title: Short Title
status: open | decided | deferred
date: YYYY-MM-DD
tags:
  - topic
---

# Short Title

## Context

What prompted this note?

## Decision

What are we choosing for now?

## Rationale

Why this shape?

## Consequences

What gets easier, harder, or deferred?

## Open Questions
```
