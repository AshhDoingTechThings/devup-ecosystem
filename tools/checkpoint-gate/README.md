# Checkpoint gate

A verify-only check for pull requests into `main`. It never changes code. It builds, tests and measures the PR against its base, then gives a verdict:

- **PASS:** the PR can be merged.
- **FAIL:** the PR cannot be merged until the listed fixes are made.

It writes `report.md`, `report.html` (one page you can share) and `report.json` to `gate-report/`. Under GitHub Actions it also adds the report to the run's summary page.

It covers all three apps: `frontend/` (Next.js), `backend/admin/` (Vite admin portal) and `backend/` (Express + Prisma).

## What it checks

| Check | Fails when |
|---|---|
| Forbidden files | an `.env`, key, certificate, build output (`dist/`, `.next/`…) or a file over 5 MB is added or changed |
| AI tool configuration | sensitive AI execution config changes without an approving review, or any AI tool file gains an unsafe command. See [AI tool configuration policy](#ai-tool-configuration-policy) |
| Secrets in code | an added line looks like a database URI with a password (localhost and placeholders are fine), a JWT or Supabase key, a Resend, OpenRouter, AWS, GitHub or Slack key, a private key or a live payment key |
| Backend tests | any test in `backend/test` fails |
| Build every app · compressed size | `npm run build` fails in an app (this includes its type check), or a web app's gzipped JS + CSS grows past its budget in `budgets.json` |
| Code health | the PR **adds** a function that is too complex (more than 20 branches) or too long (more than 250 lines), nests more than 5 levels deep, takes more than 5 parameters, or adds unused values or dead code |
| Duplicated code | the PR adds a copy-paste block of 12 lines or more instead of reusing existing code |
| Unused files and API functions | the PR leaves a file that nothing imports, or an API function or data hook (`frontend/lib/api`, `frontend/hooks`, `frontend/lib/hooks`, admin `src/hooks`) that nothing calls |
| Screens wired to real API endpoints | a screen calls `api.get/post/put/patch/delete("/api/…")` on a method and path that no Express route defines. The build and the type check can't catch this; the button only fails (404) when clicked |
| AI assistance | a PR description is given (`--pr-body-file`) with no `AI-assisted: N%` line |

These checks only report and never fail the gate:

| Check | Reports |
|---|---|
| Complexity | the average and highest complexity of the functions the PR wrote or changed |
| AI assistance | the declared share, and the share of lines from commits marked with an AI co-author trailer; it warns when the declaration is lower than what the commits show |
| AI tool configuration | agent instructions (`CLAUDE.md`, `AGENTS.md`, rules) that changed, and approved sensitive changes, each with its file and reason |
| Tests for backend changes | a warning when `backend/src` changes but nothing in `backend/test` does |
| Size of the change | a warning past 1,500 added lines |

The code-quality checks (code health, duplicates, unused, API wiring) compare the PR with its base. They fail only on what the PR adds, so older debt in a file you touch is shown but not blamed on you.

AI-written code that isn't declared can't be detected reliably. That's why the gate asks for the declaration and cross-checks it against commit trailers.

## AI tool configuration policy

Only files the branch adds, changes, renames or deletes relative to its base (`origin/main`) are classified. AI files that are already committed and untouched never trigger anything. Every finding names the file, what happened to it (added, modified +3/−1…), its class and the reason. For JSON configs it also lists the exact keys that changed.

| Class | Files | Result |
|---|---|---|
| **Blocked until reviewed** | MCP server definitions (`.mcp.json`, `.cursor/mcp.json`, `mcpServers` added to any config file); `.claude/settings.json` and `settings.local.json` (tool permissions, command allowlists, hooks); `.claude/hooks/` and any script in an AI tool folder; Cursor, Gemini, Codex, Aider, Continue and Windsurf settings and hooks; custom commands, subagents or skills that grant tools (`allowed-tools:`) or run shell (``!`cmd` ``); the gate's own rules (`tools/checkpoint-gate/`, except its README and tests). Deleting these or moving them out of their path counts too | **Fail** until approved |
| **Launch config** | `.claude/launch.json` | **Fail** until approved when what it runs changes (`runtimeExecutable`, `runtimeArgs`, `program`, `args`, `env`, `cwd`, tasks, a configuration added or removed, or invalid JSON). Any other change, such as `port` or `name`, is review |
| **Review** | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/`, Copilot instructions and prompts, plain custom commands and subagents, AI ignore files, other files in AI tool folders | **Warning**: reported for review, not a violation |
| **Unsafe** | A line added to any file above that downloads and runs a script (`curl … \| sh`), turns off agent permissions or sandbox (`--dangerously-skip-permissions`, `bypassPermissions`), grants unrestricted `Bash`, deletes `~` or `/`, opens a reverse shell, or uploads `.env`/keys | **Fail**. An approval does not clear it |

**What counts as review.** Run the gate with the PR's GitHub reviews. Only an APPROVED review clears blocked changes, and only if all of these hold:
- it is that reviewer's latest verdict
- it is from someone other than the PR author
- it is for the exact commit being checked, so a new push needs a new approval
- if `ai-policy.json` lists `reviewers`, the reviewer is on that list

The gate reads that list from the base branch, so a PR cannot add its own author.

```bash
gh api repos/{owner}/{repo}/pulls/{n}/reviews > reviews.json
node tools/checkpoint-gate/run.js --base origin/main --reviews-file reviews.json --pr-author <author-login>
```

Without `--reviews-file`, nothing can be approved, so blocked changes fail. A workflow should also run on `pull_request_review`, so an approval re-runs the gate.

**Secrets are separate.** The secrets check scans every added line of every file, AI files included, and no approval affects it.

## Run it before you open a PR

```bash
cd tools/checkpoint-gate && npm ci && npm test && cd ../..
git fetch origin main
node tools/checkpoint-gate/run.js --base origin/main
# faster while iterating:  --skip-tests --skip-build
# open gate-report/report.html
```

- **Tests never touch a real database.** `backend/.env` points at production, so the gate always overrides `DATABASE_URL` and `DIRECT_URL`. Tests that need a database run only when `TEST_DATABASE_URL` points at a Postgres on localhost (it gets reset); otherwise they are skipped and the report says so.
- **Builds** run each app's real `npm run build`, so they need each app's `node_modules` and env files (`frontend/.env.local`). Stop `next dev` first; `next build` rewrites `frontend/.next`.

## How the API wiring check reads the code

- **Server routes:** every `app.use("/api/…", router)` in `backend/src/app.ts`, plus the `router.get/post/…("/path")` calls in each mounted router file.
- **Screen calls:** literal or template paths passed to `api.*` in the frontend and admin portal. A leading `${base}` is filled in when `base` is a string constant in the same file.
- **Not checked:** paths built entirely from variables.

## Make it binding (one-time, repository admin)

This needs a workflow in `.github/workflows/` that runs the gate on pull requests into `main` (and on `pull_request_review`). It should run the gate's code from the base branch, not the PR's, so a PR cannot weaken the gate for itself; the "gate rules" class above makes such a change visible, but only base-branch code makes it binding. On GitHub, go to **Settings → Branches → Add rule** for `main`:

- Require a pull request before merging.
- Require status checks to pass, and select **Checkpoint gate** (plus **CI**).
- Do not allow bypassing the above settings.

## Tests

```bash
cd tools/checkpoint-gate && npm test
```

`test/aiPolicy.test.js` checks every class of the AI policy and the review rules. `test/gate.integration.test.js` builds a throwaway git repo with an `origin/main` and runs the whole gate against feature branches.

## Changing a threshold

Thresholds live in `eslint.config.mjs` (code health), `run.js` (duplicate size, PR size, large-file size) and `budgets.json` (gzipped KB per web app; set on 2026-11-15 at about 10% above the sizes then: frontend 1,032 KB, admin 317 KB). Change them in a PR of their own, with the reason, so the bar only moves on purpose.
