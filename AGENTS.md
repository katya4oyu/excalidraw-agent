Please provide all answers in Japanese.

# Repository Agent Instructions

## Temporary Artifacts

- Do not save screenshots, browser verification images, generated previews, or other temporary inspection artifacts in the repository root or tracked source directories.
- Put disposable artifacts under `/private/tmp` or another clearly external temporary directory.
- If a generated image is meant to become a project asset, place it directly in the intended asset directory and make sure it is referenced by the relevant document or code.
- Before finishing work, run `git status --short` and remove accidental untracked temporary files from the worktree.

## Git Hygiene

- When the user asks for an implementation or documentation change, commit the completed work before finishing the turn unless the user explicitly asks not to commit.
- Split commits by logical unit. Do not combine unrelated implementation, documentation, generated assets, and cleanup changes in one commit when they can be reviewed separately.
- After committing, run `git status --short` and leave the worktree clean unless there are intentional uncommitted changes. If anything remains uncommitted, explain exactly what remains and why.
- Do not commit disposable screenshots, browser verification images, generated previews, or other temporary inspection artifacts.
- If verification cannot be run, still commit the completed changes when appropriate and state the verification gap in the final response.

## Local Issues

Use `issues/` for repository-level decisions, open questions, design tradeoffs,
and work items that should be preserved in Git but do not need GitHub Issues.

Create or update an issue when a change introduces or resolves any of these:

- a non-obvious design decision
- a boundary between runtime, config, storage, API, data, or agent
  responsibilities
- a tradeoff that future work will need to remember
- an open question that should not disappear into chat history
- a decision that changes how contributors or agents should work

Do not create an issue for every small edit. If the decision is already fully
captured in stable documentation and has no unresolved tradeoff, updating docs
is enough.

Prefer updating an existing issue over creating a near-duplicate.

When an issue becomes stable project knowledge, summarize the result in `docs/`
and keep the issue as decision history.

## Local Development Servers

- Use the portless tasks for browser-facing verification by default:
  - `mise run server:portless`
  - `mise run web:portless`
- Prefer the portless URLs over raw localhost URLs:
  - web: `http://excalidraw-agent.localhost:1355`
  - API: `http://api.excalidraw-agent.localhost:1355`
- Before starting another dev server, check for existing listeners and avoid multiple Vite/server instances for the same app. If an old instance is stale or conflicting, stop it instead of starting a new one.
- If the Portless proxy is not running, start the HTTP proxy with `pnpm dlx portless proxy start --port 1355 --no-tls` before running the portless tasks.
- Use raw `mise run web` / `mise run server` only for narrow debugging, and explain why portless is not being used.
