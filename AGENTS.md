Please provide all answers in Japanese.

# Repository Agent Instructions

## Temporary Artifacts

- Do not save screenshots, browser verification images, generated previews, or other temporary inspection artifacts in the repository root or tracked source directories.
- Put disposable artifacts under `/private/tmp` or another clearly external temporary directory.
- If a generated image is meant to become a project asset, place it directly in the intended asset directory and make sure it is referenced by the relevant document or code.
- Before finishing work, run `git status --short` and remove accidental untracked temporary files from the worktree.
