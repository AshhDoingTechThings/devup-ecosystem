#!/usr/bin/env node
/**
 * Checkpoint gate — verify a pull request into main. It never fixes anything:
 * it measures, compares the PR against its base, and says PASS or FAIL with
 * what has to change.
 *
 *   node tools/checkpoint-gate/run.js [--base origin/main] [--out gate-report]
 *        [--pr-body-file body.md] [--reviews-file reviews.json --pr-author login]
 *        [--skip-tests] [--skip-build]
 *
 * --reviews-file is the PR's reviews as GitHub returns them
 * (gh api repos/{owner}/{repo}/pulls/{n}/reviews). It is the only way to
 * approve a change to sensitive AI configuration; see lib/aiPolicy.js.
 *
 * Writes report.md, report.html and report.json to --out, and exits 1 on FAIL.
 * Rules that judge code quality fail only on what the PR ADDS; debt that was
 * already on the base is shown but not blamed on this PR.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const reach = require('./lib/reach');
const { renderMarkdown, renderHtml } = require('./lib/report');
const aiPolicy = require('./lib/aiPolicy');

const ROOT = path.resolve(__dirname, '../..');
const CODE = /\.(jsx?|tsx?|mjs|cjs)$/;
const SCANNED = /^(frontend|backend)\//;
const NOT_SCANNED = /(^|\/)(node_modules|dist|\.next|seed|migrations)\/|\.d\.ts$/;
/** Files bigger than this belong in storage or a CDN, not in git. */
const MAX_FILE_MB = 5;

/** Each app's production build, and where its shipped JS + CSS lands. */
const BUILDS = [
  { name: 'frontend', dir: 'frontend', out: '.next/static' },
  { name: 'admin', dir: 'backend/admin', out: 'dist' },
  { name: 'backend', dir: 'backend', out: null },
];
/** The folders the duplicate check reads. */
const SOURCE_DIRS = ['frontend/app', 'frontend/components', 'frontend/lib', 'frontend/hooks', 'backend/admin/src', 'backend/src'];

/* Arguments */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const BASE_REF = opt('base', 'origin/main');
const OUT = path.resolve(ROOT, opt('out', 'gate-report'));
const PR_BODY_FILE = opt('pr-body-file', null);
const REVIEWS_FILE = opt('reviews-file', null);
const PR_AUTHOR = opt('pr-author', null);

/* Helpers */

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
const run = (cmd, args, cwd, env = process.env) => spawnSync(cmd, args, {
  cwd, env, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024,
});
const lastLines = (text, n = 25) => (text || '').trim().split('\n').slice(-n).join('\n');
const kb = (bytes) => Math.round(bytes / 102.4) / 10;

const checks = [];
function check(id, title, status, summary, { details = [], fix = [] } = {}) {
  checks.push({ id, title, status, summary, details, fix });
}

/* What changed */

let baseSha;
try {
  baseSha = git('merge-base', BASE_REF, 'HEAD');
} catch {
  console.error(`\nCheckpoint gate: cannot find the base "${BASE_REF}". Fetch it first (git fetch origin main) or pass --base <ref>.`);
  process.exit(2);
}
const headSha = git('rev-parse', 'HEAD');

const changed = git('diff', '--name-status', '-M', baseSha, 'HEAD').split('\n').filter(Boolean).map((line) => {
  const parts = line.split('\t');
  return { status: parts[0][0], file: parts[parts.length - 1], from: parts[0][0] === 'R' ? parts[1] : null };
});
/** A moved file's path before this change, so its old issues are not counted as new. */
const priorPath = new Map(changed.filter((c) => c.from).map((c) => [c.file, c.from]));
const live = changed.filter((c) => c.status !== 'D').map((c) => c.file);

const numstat = git('diff', '--numstat', '-M', baseSha, 'HEAD').split('\n').filter(Boolean);
let added = 0;
let removed = 0;
for (const line of numstat) {
  const [a, r] = line.split('\t');
  if (a !== '-') added += Number(a);
  if (r !== '-') removed += Number(r);
}

/** Line numbers each file gained, from a zero-context diff. */
const addedLines = new Map();
{
  let file = null;
  for (const line of git('diff', '-U0', '-M', baseSha, 'HEAD').split('\n')) {
    if (line.startsWith('+++ ')) { file = line.startsWith('+++ b/') ? line.slice(6) : null; continue; }
    const hunk = file && line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (!addedLines.has(file)) addedLines.set(file, new Set());
    for (let i = 0; i < count; i++) addedLines.get(file).add(start + i);
  }
}
const isAdded = (file, line) => addedLines.get(file)?.has(line) || false;

/** Each file's added lines (text) and removed-line count, base → head. */
const fileDiff = new Map();
{
  let inHeader = false;
  let oldFile = null;
  let file = null;
  for (const line of git('diff', '-U0', '-M', baseSha, 'HEAD').split('\n')) {
    if (line.startsWith('diff --git ')) { inHeader = true; file = null; oldFile = null; continue; }
    if (inHeader) {
      if (line.startsWith('--- ')) oldFile = line.startsWith('--- a/') ? line.slice(6) : null;
      else if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : oldFile;
      else if (line.startsWith('@@')) inHeader = false;
      if (file && !fileDiff.has(file)) fileDiff.set(file, { added: [], removed: 0 });
      continue;
    }
    if (!file || line.startsWith('@@')) continue;
    if (line.startsWith('+')) fileDiff.get(file).added.push(line.slice(1));
    else if (line.startsWith('-')) fileDiff.get(file).removed++;
  }
}

const commits = git('log', '--format=%H%x1f%an%x1f%s%x1f%B%x1e', `${baseSha}..HEAD`)
  .split('\x1e').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const [sha, author, subject, body] = s.split('\x1f'); return { sha, author, subject, body }; });

/* The base, checked out beside the PR for before/after comparisons */

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-base-'));
git('worktree', 'add', '--detach', '--force', baseDir, baseSha);

async function main() {
  // 1. Forbidden files
  {
    const rules = [
      [/(^|\/)\.env(?!.*\.(example|sample|template)$)[^/]*$/, 'environment file (secrets live outside git)'],
      [/\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519)/, 'private key or certificate'],
      [/(^|\/)(node_modules|dist|build|coverage|\.next)\//, 'generated output'],
    ];
    const hits = [];
    for (const file of live) for (const [re, why] of rules) if (re.test(file)) hits.push(`\`${file}\` — ${why}`);
    for (const file of live) {
      const full = path.join(ROOT, file);
      const mb = fs.existsSync(full) ? fs.statSync(full).size / 1024 / 1024 : 0;
      if (mb > MAX_FILE_MB) hits.push(`\`${file}\` — ${Math.round(mb * 10) / 10} MB, over ${MAX_FILE_MB} MB (keep media in storage, not git)`);
    }
    check('files', 'Forbidden files', hits.length ? 'fail' : 'pass',
      hits.length ? `${hits.length} file(s) that must not be committed` : 'No secrets, keys, build output or large files added',
      { details: hits, fix: hits.length ? ['Remove these files from the PR (git rm --cached) and keep them out with .gitignore. Put images and video in Supabase Storage or frontend/public only when small.'] : [] });
  }

  // 1b. AI tool configuration and agent instructions (policy: lib/aiPolicy.js).
  // Only files this PR adds, changes, renames or deletes count. Secrets in them
  // are still caught by check 2, which no approval affects.
  {
    const readAt = (rev, file) => {
      try { return git('show', `${rev === 'base' ? baseSha : headSha}:${file}`); } catch { return null; }
    };
    // Who may approve comes from the BASE, so a PR cannot add its own author.
    const policyText = readAt('base', 'tools/checkpoint-gate/ai-policy.json')
      ?? fs.readFileSync(path.join(__dirname, 'ai-policy.json'), 'utf8');
    const reviewers = (() => { try { return JSON.parse(policyText).reviewers || []; } catch { return []; } })();
    const reviews = REVIEWS_FILE && fs.existsSync(REVIEWS_FILE) ? JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8')) : null;
    const findings = aiPolicy.classifyAiChanges({
      changes: changed,
      added: (f) => fileDiff.get(f)?.added || [],
      stat: (f) => (fileDiff.has(f) ? { added: fileDiff.get(f).added.length, removed: fileDiff.get(f).removed } : null),
      read: readAt,
    });
    const approval = aiPolicy.evaluateApproval({ reviews, author: PR_AUTHOR, headSha, reviewers });
    const result = aiPolicy.summarize(aiPolicy.applyApproval(findings, approval), approval);
    check('ai-config', 'AI tool configuration', result.status, result.summary, { details: result.details, fix: result.fix });
  }

  // 2. Secrets in added lines
  {
    const patterns = [
      [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
      [/mongodb(\+srv)?:\/\/[^\s:/'"]+:[^\s@'"]+@/, 'database URI with a password'],
      // Local and placeholder passwords (test:test@localhost, [YOUR-PASSWORD]) are fine.
      [/postgres(?:ql)?:\/\/[^\s:/'"]+:[^\s@'"[<]+@(?!localhost|127\.0\.0\.1)/, 'database URI with a password'],
      [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT (Supabase key or session token)'],
      [/\bsb_secret_[A-Za-z0-9_-]{20,}/, 'Supabase secret key'],
      [/\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/, 'Resend API key'],
      [/\bsk-or-v1-[a-f0-9]{32,}/, 'OpenRouter API key'],
      [/\brzp_live_[A-Za-z0-9]{10,}/, 'live Razorpay key'],
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
      [/\b(sk|rk)_live_[0-9a-zA-Z]{16,}/, 'live payment key'],
      [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
      [/gh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
      [/xox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
    ];
    const hits = [];
    let file = null;
    let lineNo = 0;
    for (const line of git('diff', '-U0', baseSha, 'HEAD').split('\n')) {
      if (line.startsWith('+++ ')) { file = line.slice(6); continue; }
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
      if (hunk) { lineNo = Number(hunk[1]); continue; }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        for (const [re, what] of patterns) if (re.test(line)) hits.push(`\`${file}:${lineNo}\` — looks like a ${what}`);
        lineNo++;
      }
    }
    check('secrets', 'Secrets in code', hits.length ? 'fail' : 'pass',
      hits.length ? `${hits.length} possible secret(s) in added lines` : 'No keys, tokens or passwords in added lines',
      { details: hits, fix: hits.length ? ['Move the value to an environment variable, remove it from the branch history, and rotate the credential — treat it as leaked.'] : [] });
  }

  // 3. Backend tests. The database is never the one in backend/.env (that is
  // production): it is TEST_DATABASE_URL on localhost, or an address with no
  // database at all, so tests that need one skip instead of touching real data.
  if (flag('skip-tests')) {
    check('tests', 'Backend tests', 'info', 'Skipped (--skip-tests)');
  } else {
    const testDb = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(process.env.TEST_DATABASE_URL || '')
      ? process.env.TEST_DATABASE_URL : null;
    const noDb = 'postgresql://gate:gate@127.0.0.1:1/gate_no_database';
    const env = {
      ...process.env, NODE_ENV: 'test', REDIS_ENABLED: 'false',
      DATABASE_URL: testDb || noDb, DIRECT_URL: testDb || noDb, TEST_DATABASE_URL: testDb || '',
    };
    const res = run('npm', ['test', '--silent'], path.join(ROOT, 'backend'), env);
    const out = `${res.stdout}\n${res.stderr}`;
    // node --test prints "ℹ pass 12" (spec) or "# pass 12" (TAP).
    const num = (name) => Number((out.match(new RegExp(`^(?:ℹ|#) ${name} (\\d+)`, 'm')) || [])[1] || 0);
    const [total, pass, fail, skipped] = ['tests', 'pass', 'fail', 'skipped'].map(num);
    const failed = [
      ...[...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]),
      ...[...out.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm)].map((m) => m[1]).filter((t) => !/^failing tests/.test(t)),
    ];
    const ok = res.status === 0;
    check('tests', 'Backend tests', ok ? 'pass' : 'fail',
      total ? `${pass} passed · ${fail} failed · ${skipped} skipped · ${total} total${testDb ? '' : ' · no test database'}` : 'No test summary',
      {
        details: [
          ...(ok ? [] : [...new Set(failed)].slice(0, 30).map((t) => `✗ ${t}`)),
          ...(ok || failed.length ? [] : ['```', lastLines(out), '```']),
          ...(!testDb && skipped ? ['Tests that need a database were skipped. Set TEST_DATABASE_URL to a local Postgres (it gets reset) to run them; CI does.'] : []),
        ],
        fix: ok ? [] : ['Make every backend test pass (`cd backend && npm test`).'],
      });
  }

  // 4. Production builds (they include each app's type check), and how much
  // each web app ships (gzip).
  if (flag('skip-build')) {
    check('build', 'Build every app', 'info', 'Skipped (--skip-build)');
  } else {
    const budgets = JSON.parse(fs.readFileSync(path.join(__dirname, 'budgets.json'), 'utf8'));
    const rows = [];
    const fix = [];
    let worst = 'pass';
    for (const app of BUILDS) {
      const dir = path.join(ROOT, app.dir);
      const res = run('npm', ['run', 'build', '--silent'], dir, { ...process.env, NEXT_TELEMETRY_DISABLED: '1' });
      if (res.status !== 0) {
        worst = 'fail';
        rows.push(`**${app.name}** — build failed`, '```', lastLines(`${res.stdout}\n${res.stderr}`, 15), '```');
        fix.push(`Fix the ${app.name} build (\`cd ${app.dir} && npm run build\`).`);
        continue;
      }
      if (!app.out) { rows.push(`✓ **${app.name}** — builds`); continue; }
      let raw = 0;
      let gz = 0;
      const walk = (d) => {
        if (!fs.existsSync(d)) return;
        for (const n of fs.readdirSync(d)) {
          const p = path.join(d, n);
          if (fs.statSync(p).isDirectory()) walk(p);
          else if (/\.(js|css)$/.test(n)) { const b = fs.readFileSync(p); raw += b.length; gz += zlib.gzipSync(b, { level: 9 }).length; }
        }
      };
      walk(path.join(dir, app.out));
      const budget = budgets[app.name];
      const over = budget && kb(gz) > budget;
      if (over) { worst = 'fail'; fix.push(`${app.name} ships ${kb(gz)} KB gzipped, over its ${budget} KB budget — lazy-load the new code or drop a dependency. Raise the budget in tools/checkpoint-gate/budgets.json only with a reason in the PR.`); }
      rows.push(`${over ? '✗' : '✓'} **${app.name}** — ${kb(raw)} KB raw · **${kb(gz)} KB gzipped**${budget ? ` (budget ${budget} KB)` : ''}`);
    }
    check('build', 'Build every app · compressed size', worst,
      worst === 'pass' ? `All ${BUILDS.length} apps build and stay within their gzip budgets` : 'A build failed or an app grew past its budget',
      { details: rows, fix });
  }

  // 5. Code health: complexity, depth, size, dead values — NEW violations only
  const codeFiles = live.filter((f) => CODE.test(f) && SCANNED.test(f) && !NOT_SCANNED.test(f));
  const { ESLint } = require('eslint');
  const lintAt = async (cwd, files) => {
    const present = files.filter((f) => fs.existsSync(path.join(cwd, f)));
    if (!present.length) return [];
    const eslint = new ESLint({ cwd, overrideConfigFile: path.join(__dirname, 'eslint.config.mjs'), errorOnUnmatchedPattern: false });
    const results = await eslint.lintFiles(present);
    return results.flatMap((r) => r.messages.filter((m) => m.ruleId).map((m) => ({
      file: path.relative(cwd, r.filePath).split(path.sep).join('/'), rule: m.ruleId, line: m.line, message: m.message,
    })));
  };
  {
    const basePaths = codeFiles.map((f) => priorPath.get(f) || f);
    const newPathOf = new Map(codeFiles.map((f, i) => [basePaths[i], f]));
    const [head, baseRaw] = await Promise.all([lintAt(ROOT, codeFiles), lintAt(baseDir, basePaths)]);
    const base = baseRaw.map((v) => ({ ...v, file: newPathOf.get(v.file) || v.file }));
    const count = (list) => list.reduce((m, v) => m.set(`${v.file}|${v.rule}`, (m.get(`${v.file}|${v.rule}`) || 0) + 1), new Map());
    const before = count(base);
    const after = count(head);
    const fresh = [];
    for (const [key, n] of after) {
      const extra = n - (before.get(key) || 0);
      if (extra <= 0) continue;
      const [file, rule] = key.split('|');
      // Point at the ones on lines this PR wrote, where the new violation must be.
      const candidates = head.filter((v) => v.file === file && v.rule === rule)
        .sort((a, b) => Number(isAdded(b.file, b.line)) - Number(isAdded(a.file, a.line)));
      fresh.push(...candidates.slice(0, extra));
    }
    const debt = head.length - fresh.length;
    check('health', 'Code health (new issues)', fresh.length ? 'fail' : 'pass',
      fresh.length
        ? `${fresh.length} new issue(s) in ${new Set(fresh.map((f) => f.file)).size} file(s)`
        : `No new issues${debt ? ` · ${debt} older issue(s) remain in touched files` : ''}`,
      {
        details: fresh.map((v) => `\`${v.file}:${v.line}\` **${v.rule}** — ${v.message}`),
        fix: fresh.length ? ['Split long or branchy functions, flatten deep nesting, pass an object instead of many parameters, and delete values that are never used.'] : [],
      });
  }

  // 6. Complexity of the functions this PR wrote or changed (measurement)
  {
    const eslint = new ESLint({
      cwd: ROOT,
      overrideConfigFile: true,
      overrideConfig: [{
        files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
        linterOptions: { reportUnusedDisableDirectives: 'off', noInlineConfig: true },
        languageOptions: {
          parser: require('typescript-eslint').parser,
          ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: { complexity: ['warn', 0] },
      }],
    });
    const results = codeFiles.length ? await eslint.lintFiles(codeFiles.filter((f) => fs.existsSync(path.join(ROOT, f)))) : [];
    const fns = [];
    for (const r of results) {
      const file = path.relative(ROOT, r.filePath).split(path.sep).join('/');
      for (const m of r.messages) {
        const c = m.message.match(/complexity of (\d+)/);
        if (c && isAdded(file, m.line)) fns.push({ file, line: m.line, n: Number(c[1]), name: (m.message.match(/^(.*?) has a complexity/) || [])[1] || 'function' });
      }
    }
    fns.sort((a, b) => b.n - a.n);
    const avg = fns.length ? Math.round((fns.reduce((s, f) => s + f.n, 0) / fns.length) * 10) / 10 : 0;
    const high = fns.filter((f) => f.n > 10).length;
    check('complexity', 'Complexity of new/changed functions', 'info',
      fns.length ? `${fns.length} function(s) · average ${avg} · highest ${fns[0].n} · ${high} above 10` : 'No functions added or changed',
      { details: fns.slice(0, 10).map((f) => `${f.n} — ${f.name} \`${f.file}:${f.line}\``) });
  }

  // 7. Duplicated code the PR adds
  {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cpd-'));
    // The gate's own copy (tools/checkpoint-gate/node_modules); its package.json is not exported.
    const jscpdDir = path.join(__dirname, 'node_modules', 'jscpd');
    const { bin } = JSON.parse(fs.readFileSync(path.join(jscpdDir, 'package.json'), 'utf8'));
    const jscpd = path.join(jscpdDir, typeof bin === 'string' ? bin : bin.jscpd);
    const dirs = SOURCE_DIRS.filter((d) => fs.existsSync(path.join(ROOT, d)));
    if (dirs.length) run(process.execPath, [jscpd, ...dirs, '--min-lines', '12', '--min-tokens', '80', '--format', 'typescript,tsx,javascript,jsx',
      '--ignore', '**/node_modules/**,**/dist/**,**/.next/**,**/seed/**,**/migrations/**,**/*.test.*,**/*.d.ts',
      '--reporters', 'json', '--output', outDir, '--silent'], ROOT);
    const reportFile = path.join(outDir, 'jscpd-report.json');
    const data = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : { duplicates: [], statistics: { total: {} } };
    // jscpd sometimes reports a TSX block's end before its start; order them.
    const span = (f) => {
      const a = f.start ?? f.startLoc?.line;
      const b = f.end ?? f.endLoc?.line;
      return { file: f.name.split(path.sep).join('/'), start: Math.min(a, b), end: Math.max(a, b) };
    };
    const mostlyNew = (s) => {
      let n = 0;
      for (let l = s.start; l <= s.end; l++) if (isAdded(s.file, l)) n++;
      return n >= (s.end - s.start + 1) / 2;
    };
    const fresh = data.duplicates.map((d) => [span(d.firstFile), span(d.secondFile), d.lines])
      .filter(([a, b]) => mostlyNew(a) || mostlyNew(b));
    const pct = data.statistics?.total?.percentage;
    check('duplicates', 'Duplicated code', fresh.length ? 'fail' : 'pass',
      `${fresh.length ? `${fresh.length} new copy-paste block(s)` : 'No new copy-paste blocks'}${pct != null ? ` · whole codebase ${Math.round(pct * 10) / 10}% duplicated` : ''}`,
      {
        details: fresh.slice(0, 25).map(([a, b, lines]) => `${lines} lines: \`${a.file}:${a.start}-${a.end}\` ≈ \`${b.file}:${b.start}-${b.end}\``),
        fix: fresh.length ? ['Use the existing code instead of copying it — extract a shared function or component and call it from both places.'] : [],
      });
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  // 8. Unused files and API functions the PR leaves behind
  {
    const label = { frontend: 'frontend file nothing imports', admin: 'admin portal file nothing imports', backend: 'backend file nothing imports or runs' };
    const files = (root) => reach.unreachableFiles(root).map((u) => `${label[u.app]}: \`${u.file}\``);
    const apis = (root) => reach.unusedApiExports(root).map((h) => `API function or hook nothing calls: \`${h}\``);
    const headList = [...files(ROOT), ...apis(ROOT)];
    const baseList = new Set([...files(baseDir), ...apis(baseDir)]);
    const fresh = headList.filter((x) => !baseList.has(x));
    const debt = headList.length - fresh.length;
    check('unused', 'Unused files and API functions', fresh.length ? 'fail' : 'pass',
      fresh.length
        ? `${fresh.length} new unused file(s) or API function(s)`
        : `Nothing new left unused${debt ? ` · ${debt} older unused item(s) remain` : ''}`,
      {
        details: fresh,
        fix: fresh.length ? ['Delete what nothing uses, or wire it in. Replaced code must be removed in the same PR, not left beside the new version.'] : [],
      });
  }

  // 8b. Screens calling API endpoints the server doesn't define. The build and
  // the type check can't see this; the button only fails (404) when clicked.
  {
    const head = reach.missingEndpoints(ROOT);
    const baseKeys = new Set(reach.missingEndpoints(baseDir).map((m) => m.key));
    const fresh = head.filter((m) => !baseKeys.has(m.key));
    const old = head.filter((m) => baseKeys.has(m.key));
    check('api-wiring', 'Screens wired to real API endpoints', fresh.length ? 'fail' : 'pass',
      `${fresh.length ? `${fresh.length} new call(s) to endpoints the server doesn't define` : 'Every API call the PR adds has a server route'}${old.length ? ` · ${old.length} older broken call(s)` : ''}`,
      {
        details: [
          ...fresh.map((m) => `new: \`${m.text}\``),
          ...old.map((m) => `already broken on the base: \`${m.text}\``),
        ],
        fix: fresh.length ? ['Add the route on the server (backend/src/modules/…, mounted in app.ts), or call the path it really has.'] : [],
      });
  }

  // 9. AI assistance: what the author declared, and what the commits say
  {
    const AI = /co-authored-by:[^\n]*(claude|anthropic|copilot|cursor|openai|chatgpt|gpt-|gemini|codeium|windsurf|devin|aider|tabnine)|generated with[^\n]*(claude|copilot|cursor|chatgpt|gemini)/i;
    let aiAdded = 0;
    const aiCommits = [];
    for (const c of commits) {
      if (!AI.test(c.body || '')) continue;
      aiCommits.push(`${c.sha.slice(0, 7)} ${c.subject}`);
      for (const line of git('show', '--numstat', '--format=', c.sha).split('\n')) {
        const n = Number(line.split('\t')[0]);
        if (Number.isFinite(n)) aiAdded += n;
      }
    }
    const detectedPct = added ? Math.min(100, Math.round((aiAdded / added) * 100)) : 0;
    let declared = null;
    if (PR_BODY_FILE && fs.existsSync(PR_BODY_FILE)) {
      const body = fs.readFileSync(PR_BODY_FILE, 'utf8');
      const m = body.match(/AI[- ]?(?:assisted|assistance|generated|written|share)?[^:\n]{0,40}:\s*(\d{1,3})\s*%/i);
      if (m) declared = Math.min(100, Number(m[1]));
      else if (/\[x\]\s*no ai/i.test(body)) declared = 0;
    }
    const missing = PR_BODY_FILE && declared === null;
    const under = declared !== null && detectedPct > declared;
    check('ai', 'AI assistance', missing ? 'fail' : under ? 'warn' : 'info',
      `${declared === null ? 'Not declared' : `Declared ${declared}%`} · commits marked as AI-assisted: ${aiCommits.length} of ${commits.length} (${detectedPct}% of added lines)`,
      {
        details: [
          ...aiCommits.map((c) => `AI-marked commit: ${c}`),
          'Only declared use and commit trailers can be counted; unmarked AI-written code cannot be detected reliably, so the declaration is required.',
        ],
        fix: missing
          ? ['Fill in "AI-assisted: N%" in the PR description (the template has the line) — 0% if none.']
          : under ? [`Commits show at least ${detectedPct}% AI-assisted lines but ${declared}% was declared — correct the declaration.`] : [],
      });
  }

  // 10. Tests travel with server changes
  {
    const serverSrc = live.filter((f) => /^backend\/src\//.test(f) && !/(seed|migrations)\//.test(f));
    const testsTouched = live.some((f) => /^backend\/test\//.test(f));
    check('test-coverage', 'Tests for backend changes', serverSrc.length && !testsTouched ? 'warn' : 'pass',
      serverSrc.length && !testsTouched ? `${serverSrc.length} backend file(s) changed with no test added or changed` : 'Backend changes come with tests (or there are none)',
      { fix: serverSrc.length && !testsTouched ? ['Add or update a test in backend/test that covers the behaviour this PR changes.'] : [] });
  }

  // 11. Size of the PR
  check('size', 'Size of the change', added > 1500 ? 'warn' : 'pass',
    `${changed.length} file(s) · +${added} / -${removed} lines · ${commits.length} commit(s)`,
    { fix: added > 1500 ? ['Split this PR — over 1,500 added lines cannot be reviewed properly in one go.'] : [] });
}

main()
  .catch((err) => check('gate', 'Gate itself', 'fail', `The gate crashed: ${err.message}`, { details: ['```', err.stack || '', '```'] }))
  .finally(() => {
    try { git('worktree', 'remove', '--force', baseDir); } catch { fs.rmSync(baseDir, { recursive: true, force: true }); }
    const verdict = checks.some((c) => c.status === 'fail') ? 'FAIL' : 'PASS';
    const meta = {
      verdict, base: BASE_REF, baseSha, headSha, added, removed,
      files: changed.length, commits: commits.length,
      areas: [...new Set(changed.map((c) => (c.file.startsWith('backend/admin/') ? 'admin' : c.file.split('/')[0])))].sort(),
      at: new Date().toISOString(),
    };
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ ...meta, checks }, null, 2));
    fs.writeFileSync(path.join(OUT, 'report.md'), renderMarkdown(meta, checks));
    fs.writeFileSync(path.join(OUT, 'report.html'), renderHtml(meta, checks));
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(meta, checks));
    console.log(`\nCheckpoint gate: ${verdict}`);
    for (const c of checks) console.log(`  [${c.status.toUpperCase().padEnd(4)}] ${c.title} — ${c.summary}`);
    console.log(`\nReport: ${path.relative(ROOT, OUT)}/report.html`);
    process.exitCode = verdict === 'FAIL' ? 1 : 0;
  });
