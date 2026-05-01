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
