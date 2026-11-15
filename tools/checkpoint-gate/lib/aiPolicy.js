/**
 * The gate's policy for AI tool configuration and agent instruction files.
 *
 * Every file a PR adds, changes, renames or deletes (relative to its base) is
 * put in one of these classes. Files that are already committed and untouched
 * are never looked at.
 *
 *   blocked  Sensitive AI execution config: MCP servers, hooks, tool
 *            permissions, command allowlists, agent security settings, and the
 *            gate's own rules. Fails until an approving PR review from someone
 *            other than the author covers the exact commit being checked.
 *   launch   .claude/launch.json. A change to the commands it runs is blocked
 *            like the above; any other change (a port, a name) is review.
 *   review   Agent instructions and docs (CLAUDE.md, AGENTS.md, rules, custom
 *            commands). Reported as a warning so a reviewer reads them; not a
 *            violation on its own.
 *   unsafe   A line the PR adds to any of these files that would run
 *            something dangerous (curl | sh, permission bypass, rm -rf ~…).
 *            Always fails. An approval does not clear it.
 *
 * Secrets in these files are caught by the gate's separate secrets check,
 * which scans every added line in every file, approved or not.
 *
 * Everything here is a pure function of its inputs, so test/ can check each
 * class without a git repository.
 */

const SCRIPT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe)$/i;
const AI_DIR = /(^|\/)(\.claude|\.cursor|\.gemini|\.codex|\.continue|\.windsurf|\.roo|\.amazonq|\.aider[^/]*|\.clinerules)(\/|$)/;
const CONFIG_FILE = /\.(json|jsonc|ya?ml|toml)$/i;

/** Sensitive AI execution configuration, by path: [pattern, category, reason]. */
const SENSITIVE = [
  [/^tools\/checkpoint-gate\/(?!README\.md$|test\/)/, 'gate rules',
    "the checkpoint gate's own rules: changing them changes what every PR is checked for"],
  [/(^|\/)\.claude\/settings\.local\.json$/, 'agent settings',
    'personal Claude Code settings (tool permissions, command allowlists, hooks): normally never committed'],
  [/(^|\/)\.claude\/settings\.json$/, 'agent settings',
    'Claude Code settings: tool permissions, command allowlists, hooks, environment and MCP servers'],
  [/(^|\/)\.claude\/hooks\//, 'hook', 'a hook: a program the agent runs automatically'],
  [/(^|\/)\.?mcp[^/]*\.(json|jsonc|ya?ml|toml)$/i, 'MCP servers',
    'MCP server definitions: each server is a program the agent can start and call'],
  [/(^|\/)\.cursor\/(hooks|cli|environment)\.json$/, 'agent settings',
    'Cursor hooks, command permissions or agent environment setup'],
  [/(^|\/)\.gemini\/settings\.json$/, 'agent settings', 'Gemini CLI settings: tools, sandbox and MCP servers'],
  [/(^|\/)\.codex\/config\.toml$/, 'agent settings', 'Codex settings: approval policy, sandbox and MCP servers'],
  [/(^|\/)\.aider(\.conf|\.model\.settings)\.ya?ml$/, 'agent settings',
    'Aider settings, including the commands it runs on its own (lint-cmd, test-cmd)'],
  [/(^|\/)\.continue\/config\.(json|ya?ml|ts)$/, 'agent settings', 'Continue settings: tools, commands and MCP servers'],
  [/(^|\/)\.windsurf\/hooks\.json$/, 'hook', 'Windsurf hooks: programs the agent runs automatically'],
];

const LAUNCH = /(^|\/)\.claude\/launch\.json$/;

/** Agent instructions and docs: [pattern, reason]. */
const INSTRUCTIONS = [
  [/(^|\/)(CLAUDE|AGENTS|GEMINI|CLAUDE\.local)\.md$/, 'agent instructions: they shape what AI tools do in this repo'],
  [/(^|\/)\.github\/(copilot-instructions\.md|instructions\/|prompts\/)/, 'Copilot instructions or prompt files'],
  [/(^|\/)(\.cursorrules|\.windsurfrules)$|(^|\/)\.(cursor|windsurf|roo)\/rules\/|(^|\/)\.clinerules(\/|$)/, 'agent rules: instructions the agent follows'],
  [/(^|\/)\.claude\/(commands|agents|skills|output-styles)\//, 'a custom agent command, subagent or skill: instructions the agent follows'],
  [/(^|\/)\.(aider|cursor|claude|gemini)ignore$/, 'controls which files an AI tool may read'],
];

/** Instruction files whose frontmatter or body can grant tools or run commands. */
const CAN_GRANT = /(^|\/)\.claude\/(commands|agents|skills)\/|(^|\/)\.github\/prompts\//;
const GRANTS = [
  [/^\s*(allowed-tools|disallowed-tools|tools|hooks|permissionMode|permission-mode|mcpServers|mcp-servers)\s*:/,
    'grants tools or permissions in its frontmatter'],
  [/^\s*!`/, 'runs a shell command every time it is used'],
];

/** MCP servers defined inside some other config file. */
const DEFINES_MCP = /["']?(mcpServers|mcp_servers|mcp-servers)["']?\s*[:=]|^\s*\[mcp_servers/;

/** Added lines that are unsafe whatever the file: [pattern, reason, onlyYamlOrToml]. */
const UNSAFE = [
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?((ba|z|da|fi)?sh|python3?|node|perl|ruby|iex)\b/i, 'downloads a script and runs it'],
  [/\b((ba|z)?sh\s+(-c\s+)?|eval\s+)["']?\$\(\s*(curl|wget)\b/i, 'downloads a script and runs it'],
  [/\bbase64\s+(-d|--decode)\b[^\n|]*\|\s*(ba|z)?sh\b/i, 'decodes hidden text and runs it as a script'],
  [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(--no-preserve-root\s+)?(\/(\*|\s|$|["'])|~\/?(\*|\s|$|["'])|\$HOME\b|\$\{HOME\})/, 'deletes the home or root folder'],
  [/--dangerously-skip-permissions|\bbypassPermissions\b|--dangerously-bypass-approvals-and-sandbox|\bdanger-full-access\b|approval_policy\s*=\s*["']never["']|(^|\s)--yolo\b/i,
    "turns off the agent's permission prompts or sandbox"],
  // A list entry that is just Bash, Bash(*) or Bash(:*). JSON is checked key by key instead (UNRESTRICTED_SHELL).
  [/^\s*-?\s*["']?Bash(\((\*|:\*)?\))?["']?\s*,?\s*$/, 'grants unrestricted shell access (Bash with no command limit)', true],
  [/\bchmod\s+(-R\s+)?0?777\b/, 'makes files writable by everyone'],
  [/\/dev\/tcp\/|\bnc\b[^\n]*\s-e\s|\bmkfifo\b[^\n]*\bnc\b/, 'opens a reverse shell'],
  [/\b(curl|wget)\b[^\n]*(\s-d|--data[a-z-]*|\s-F|--form|\s-T|--upload-file)\s*[@<]?\S*(\.env|id_rsa|id_ed25519|\.pem|credentials|\.npmrc|\.netrc)\b/i,
    'sends a local secrets file over the network'],
  [/\b(cat|type)\s+[^\n|]*\.env\b[^\n]*\|\s*(curl|wget|nc)\b/i, 'sends a local secrets file over the network'],
];

/** A permission-list entry, from jsonChanges, that allows any shell command. */
const UNRESTRICTED_SHELL = /(^|\.)(allow|allowedTools|allowed_tools|autoApprove|alwaysAllow)\[\] "Bash(\((\*|:\*)?\))?"$/;

/** Fields in a launch configuration that decide what runs. */
const LAUNCH_EXEC = /^configurations\[[^\]]+\](\.(runtimeExecutable|runtimeArgs|program|command|args|cwd|env|envFile|preLaunchTask|postDebugTask|shell|console)\b|$)/;

/* JSON helpers */

function parseJson(text) {
  if (text == null) return { ok: true, value: undefined };
  try { return { ok: true, value: JSON.parse(text) }; } catch { /* try JSONC */ }
  try {
    const stripped = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1');
    return { ok: true, value: JSON.parse(stripped) };
  } catch { return { ok: false }; }
}

/** Flatten to path → value. Lists of plain values become sets; objects in a list are keyed by `name` when they have one. */
function flatten(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) {
      for (const v of value) out.set(`${prefix}[] ${JSON.stringify(v)}`, true);
      if (!value.length) out.set(prefix, '[]');
    } else {
      value.forEach((v, i) => flatten(v, `${prefix}[${v && typeof v === 'object' && typeof v.name === 'string' ? v.name : i}]`, out));
    }
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) out.set(prefix, '{}');
    for (const k of keys) flatten(value[k], prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, JSON.stringify(value));
  }
  return out;
}

/** What changed between two JSON documents, as readable lines. */
function jsonChanges(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  const out = [];
  for (const [k, v] of b) {
    if (!a.has(k)) out.push({ path: k, text: v === true ? `+ ${k.replace(/\[\] /, ': ')}` : `+ ${k} = ${v}` });
    else if (a.get(k) !== v) out.push({ path: k, text: `~ ${k}: ${a.get(k)} → ${v}` });
  }
  for (const [k, v] of a) if (!b.has(k)) out.push({ path: k, text: v === true ? `- ${k.replace(/\[\] /, ': ')}` : `- ${k}` });
  return out;
}

/* Classification */

const STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };

function pathClass(file) {
  for (const [re, category, reason] of SENSITIVE) if (re.test(file)) return { level: 'blocked', category, reason };
  if (LAUNCH.test(file)) return { level: 'launch', category: 'launch config', reason: 'development launch configuration: decides what runs when the dev environment starts' };
  if (AI_DIR.test(file) && SCRIPT.test(file)) return { level: 'blocked', category: 'hook', reason: 'an executable script in an AI tool folder (hooks and commands run these)' };
  for (const [re, reason] of INSTRUCTIONS) if (re.test(file)) return { level: 'review', category: 'instructions', reason };
  if (AI_DIR.test(file)) return { level: 'review', category: 'AI tool file', reason: 'a file in an AI tool folder' };
  return null;
}

const quote = (line) => `\`${line.trim().slice(0, 120).replace(/`/g, "'")}\``;

/**
 * Classify the AI-related files in a change set.
 *
 * @param {object} input
 * @param {{status: string, file: string, from?: string|null}[]} input.changes  git diff --name-status, base → head
 * @param {(file: string) => string[]} [input.added]   lines the change adds to a file
 * @param {(file: string) => {added: number, removed: number}|null} [input.stat]
 * @param {(rev: 'base'|'head', file: string) => string|null} [input.read]  file contents at base or head
 * @returns {object[]} findings, one per file that falls under the policy
 */
function classifyAiChanges({ changes, added = () => [], stat = () => null, read = () => null }) {
  const findings = [];
  for (const c of changes) {
    const status = STATUS[c.status] || c.status;
    const lines = c.status === 'D' ? [] : added(c.file);
    const isConfig = CONFIG_FILE.test(c.file);

    // The class by path, taking the stricter of a rename's two paths.
    let cls = pathClass(c.file);
    const fromCls = c.from ? pathClass(c.from) : null;
    const rank = { blocked: 3, launch: 2, review: 1 };
    if (fromCls && (!cls || rank[fromCls.level] > rank[cls.level])) cls = { ...fromCls, reason: `moved out of a protected path: ${fromCls.reason}` };

    // MCP servers defined in a config file the path rules don't name.
    if ((!cls || cls.level !== 'blocked') && isConfig) {
      const hit = lines.find((l) => DEFINES_MCP.test(l));
      if (hit) cls = { level: 'blocked', category: 'MCP servers', reason: `defines MCP servers (${quote(hit)}): each one is a program the agent can start` };
    }
    if (!cls) continue;

    const detail = [];
    const unsafe = [];
    let { level, reason, category } = cls;

    // Custom commands and skills can grant tools or run shell commands.
    if (level === 'review' && CAN_GRANT.test(c.file)) {
      for (const [re, why] of GRANTS) {
        const hit = lines.find((l) => re.test(l));
        if (hit) { level = 'blocked'; category = 'tool permissions'; reason = `${why}: ${quote(hit)}`; break; }
      }
    }

    // JSON configs: say which keys changed. Launch config: blocked only when what it runs changes.
    if ((level === 'blocked' || level === 'launch') && /\.jsonc?$/i.test(c.file)) {
      const before = parseJson(c.status === 'A' ? null : read('base', c.from || c.file));
      const after = parseJson(c.status === 'D' ? null : read('head', c.file));
      if (!before.ok || !after.ok) {
        detail.push('could not be read as JSON, so every line counts as a change');
        if (level === 'launch') { level = 'blocked'; reason = `${reason}; not valid JSON, so the commands it runs cannot be checked`; }
      } else {
        const changed = jsonChanges(before.value, after.value);
        for (const x of changed) {
          if (x.text.startsWith('+') && UNRESTRICTED_SHELL.test(x.path)) unsafe.push(`grants unrestricted shell access (Bash with no command limit): \`${x.path.replace('[] ', ': ')}\``);
        }
        detail.push(...changed.slice(0, 12).map((x) => x.text));
        if (changed.length > 12) detail.push(`…and ${changed.length - 12} more change(s)`);
        if (level === 'launch') {
          const exec = changed.filter((x) => LAUNCH_EXEC.test(x.path));
          if (exec.length || c.status === 'D') {
            level = 'blocked';
            reason = c.status === 'D'
              ? 'development launch configuration deleted'
              : `development launch configuration: changes what runs when the dev environment starts (${[...new Set(exec.map((x) => x.path.replace(/\[\] .*$/, '')))].slice(0, 3).join(', ')})`;
          } else {
            level = 'review';
            reason = 'development launch configuration: settings changed, but not the commands it runs';
          }
        }
      }
    } else if (level === 'launch') {
      level = 'blocked';
    }

    // Unsafe lines: fail whatever the class, and no approval clears them.
    // The gate's own source is exempt: it holds these patterns as text in order
    // to detect them. Its files are still blocked until reviewed.
    for (const l of category === 'gate rules' ? [] : lines) {
      for (const [re, why, yamlOrToml] of UNSAFE) {
        if (yamlOrToml && !/\.(ya?ml|toml)$/i.test(c.file)) continue;
        if (re.test(l)) { unsafe.push(`${why}: ${quote(l)}`); break; }
      }
    }

    const s = stat(c.file);
    findings.push({
      file: c.file,
      from: c.from || null,
      status,
      stat: s,
      level: unsafe.length ? 'unsafe' : level,
      category,
      reason: unsafe.length ? `adds an unsafe command (${unsafe.length}) — ${reason}` : reason,
      unsafe,
      detail,
      approvedBy: null,
    });
  }
  return findings;
}

/* Review */

/**
 * Whether the PR has an explicit approval that can clear blocked changes: the
 * latest review of some reviewer is APPROVED, for exactly `headSha`, from
 * someone other than the author, and on the allowed list when there is one.
 *
 * @param {object} input
 * @param {object[]|null} input.reviews  GitHub's /pulls/{n}/reviews response
 * @param {string|null} input.author     the PR author's login
 * @param {string} input.headSha         the commit the gate is checking
 * @param {string[]} [input.reviewers]   allowed approvers (empty: anyone but the author)
 */
function evaluateApproval({ reviews, author, headSha, reviewers = [] }) {
  if (!Array.isArray(reviews)) return { approved: false, reason: 'no PR reviews were given to the gate (--reviews-file), so nothing can be approved' };
  if (!author) return { approved: false, reason: 'the PR author is unknown (--pr-author), so a self-approval could not be told apart' };
  const lower = (s) => String(s || '').toLowerCase();
  const allowed = reviewers.map(lower);
  const latest = new Map();
  const ordered = [...reviews].sort((a, b) => String(a.submitted_at || '').localeCompare(String(b.submitted_at || '')));
  for (const r of ordered) {
    const who = r.user && r.user.login;
    if (!who || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue; // a comment doesn't change a verdict
    latest.set(lower(who), r);
  }
  const notes = [];
  for (const [who, r] of latest) {
    if (r.state !== 'APPROVED') continue;
    if (who === lower(author)) { notes.push(`${r.user.login} is the PR author`); continue; }
    if (r.commit_id !== headSha) { notes.push(`${r.user.login} approved an older commit (${String(r.commit_id).slice(0, 7)})`); continue; }
    if (allowed.length && !allowed.includes(who)) { notes.push(`${r.user.login} is not on the reviewer list in ai-policy.json`); continue; }
    return { approved: true, by: r.user.login, reason: `approved by ${r.user.login} at ${headSha.slice(0, 7)}` };
  }
  return { approved: false, reason: notes.length ? `no valid approval: ${notes.join('; ')}` : 'the PR has no approving review' };
}

/** Mark blocked findings as approved. Unsafe ones stay as they are. */
function applyApproval(findings, approval) {
  return findings.map((f) => (f.level === 'blocked' && approval && approval.approved ? { ...f, approvedBy: approval.by } : f));
}

/* Report */

const LABEL = {
  unsafe: '**unsafe command — fails, review cannot clear it**',
  blocked: '**blocked until reviewed**',
  review: 'review required',
};

/** The gate check: status, one-line summary, details and fixes. */
function summarize(findings, approval) {
  const unsafe = findings.filter((f) => f.level === 'unsafe');
  const blocked = findings.filter((f) => f.level === 'blocked' && !f.approvedBy);
  const approved = findings.filter((f) => f.level === 'blocked' && f.approvedBy);
  const review = findings.filter((f) => f.level === 'review');
  if (!findings.length) return { status: 'pass', summary: 'No AI tool configuration or agent instructions changed', details: [], fix: [] };

  const order = [...unsafe, ...blocked, ...approved, ...review];
  const details = [];
  for (const f of order) {
    const how = `${f.status}${f.from ? ` from \`${f.from}\`` : ''}${f.stat ? `, +${f.stat.added}/−${f.stat.removed}` : ''}`;
    const label = f.approvedBy ? `approved by ${f.approvedBy}` : LABEL[f.level];
    details.push(`\`${f.file}\` (${how}) — ${label} · ${f.category}: ${f.reason}`);
    for (const u of f.unsafe) details.push(`↳ unsafe: ${u}`);
    for (const d of f.detail) details.push(`↳ ${d}`);
  }
  if (blocked.length && approval) details.push(`Review status: ${approval.reason}.`);

  const parts = [];
  if (unsafe.length) parts.push(`${unsafe.length} unsafe`);
  if (blocked.length) parts.push(`${blocked.length} blocked until reviewed`);
  if (approved.length) parts.push(`${approved.length} approved`);
  if (review.length) parts.push(`${review.length} to review`);

  const fix = [];
  if (unsafe.length) fix.push('Remove the unsafe command(s) from the AI tool files listed. An approval does not clear these.');
  if (blocked.length) fix.push('Sensitive AI configuration changed: it needs an approving PR review from someone other than the author, on the latest commit. Pushing again needs a fresh approval.');
  return {
    status: unsafe.length || blocked.length ? 'fail' : 'warn',
    summary: `${parts.join(' · ')} — ${findings.length} AI tool file(s) changed`,
    details,
    fix,
  };
}

module.exports = { classifyAiChanges, evaluateApproval, applyApproval, summarize, jsonChanges, pathClass };
