# Development workflow

This document is a practical reference. Open it when you're starting a new piece of work or need to remember a command.

---

## Branch model

```
main        ← production only. Never push here directly.
  └─ dev    ← active integration branch. All features merge here first.
       └─ feat/<issue#>-short-name  ← one branch per issue.
```

- Work happens on feature branches, not on `dev` directly.
- `dev → main` only happens when releasing. That PR goes through the release gate.
- The CI robot runs on every PR — it checks types, lint, tests, and build on a clean Mac. The merge button stays locked until CI is green.

---

## Starting a new feature (issue → worktree → branch)

### 1. Create the issue

Go to GitHub → Issues → New Issue. Pick the **Feature** or **Bug** template. Fill in the acceptance criteria carefully — they're what the QA agent will check against.

Note the issue number (e.g. `#12`).

### 2. Create a worktree

A _worktree_ is a second copy of the repo on your disk, checked out to a different branch. It lets you work on a feature without disturbing your main checkout. Claude Code can work directly inside it.

```bash
# From the main repo directory:
git worktree add ../vidura-<issue#> -b feat/<issue#>-short-name dev

# Example:
git worktree add ../vidura-12 -b feat/12-keyboard-shortcuts dev
```

This creates a folder at `../vidura-12` on the same branch `feat/12-keyboard-shortcuts`, starting from `dev`.

Open Claude Code in the worktree folder:

```bash
cd ../vidura-<issue#>
claude
```

### 3. Plan before building

Use plan mode (`/plan`) to align on the approach before any code is written. Reference the issue number and paste the acceptance criteria. Approve the plan, then implement.

---

## During development

The git hooks run automatically when you commit or push:

- **On every commit** (`pre-commit`): formats and lints only the files you staged. Fast — typically under 5 seconds.
- **Before every push** (`pre-push`): runs typecheck + full test suite. Slower (~30–60s). If it fails, fix the issue before pushing.

If you need to skip a hook in an emergency: `git push --no-verify` (don't make a habit of it).

---

## Before opening a PR

Run the QA agent to check your work against the acceptance criteria:

```
/qa-reviewer
```

The agent will:

1. Read the linked issue's acceptance criteria
2. Read your diff
3. Check each criterion was met
4. Run lint and tests
5. Give you a PASS or FAIL verdict with specific findings

Fix anything it flags before opening the PR.

---

## Opening the PR

```bash
gh pr create --base dev --title "Short description" --body "$(cat <<'EOF'
Closes #<issue number>

## What changed
<one or two sentences>

## How to test
<steps>

## Checklist
- [ ] Acceptance criteria met
- [ ] Tests pass
- [ ] Lint passes
EOF
)"
```

Or open it on GitHub — the PR template will pre-fill the fields.

CI runs automatically. Wait for it to go green before asking for a merge.

---

## Merging and cleanup

After CI passes:

1. Merge the PR on GitHub (squash merge is fine).
2. Delete the remote branch (GitHub offers this after merge).
3. Remove the local worktree:
   ```bash
   cd ../vidura               # back to main checkout
   git worktree remove ../vidura-<issue#>
   git branch -d feat/<issue#>-short-name
   ```

---

## Releasing (`dev → main`)

Do this when `dev` has a meaningful set of stable features and you want to ship.

### 1. Bump the version

In `package.json`, increment `version` following semver:

- `0.1.0 → 0.1.1` for bug fixes
- `0.1.0 → 0.2.0` for new features
- `0.1.0 → 1.0.0` for a major milestone

Commit: `Bump version to 0.2.0`

### 2. Run the release gate agent

```
/release-gate
```

This is stricter than `qa-reviewer` — it checks the full diff since last release, the version bump, no debug code, and runs build + tests. Fix everything it flags.

### 3. Open the PR

```bash
gh pr create --base main --head dev --title "Release v0.2.0"
```

CI runs again on the `dev → main` PR. After it goes green and you're satisfied, merge.

### 4. Tag the release

After the PR is merged into `main`:

```bash
git checkout main && git pull
git tag v0.2.0
git push origin v0.2.0
```

Phase 4 (packaging) will make this tag automatically trigger a `.dmg` build on GitHub Actions. For now, the tag is just a marker in git history.

---

## TODOs (planned for later)

- **One-command issue→worktree→PR** script (so steps 1–2 above become one line)
- **Auto QA agent on PRs** via GitHub Actions (headless Claude runs `qa-reviewer` on every PR)
- **Playwright tests** for React UI and IPC flows
- **Apple code signing** once download counts grow
- **Auto-update** via `electron-updater`
