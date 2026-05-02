# Project Workflow

- After every requested feature change or bug fix, commit the completed work to `main`.
- Push `main` to `origin` after the commit succeeds so GitHub stays up to date for rollback.
- Keep generated runtime data out of git: `archive/`, `logs/`, and `data/snapshots.json` should remain ignored.
- Before committing, run focused syntax or behavior checks for the files touched when practical.
