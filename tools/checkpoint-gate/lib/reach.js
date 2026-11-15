/**
 * What is actually used, for one checkout of the repo.
 *
 *   unreachableFiles(root)   source files no entry point imports, per app
 *   unusedApiExports(root)   functions the API clients and data hooks export
 *                            that nothing else in the same app calls
 *   missingEndpoints(root)   API calls a screen makes (api.get("/api/…")) that
 *                            match no route the Express server defines. The
 *                            build and the type check cannot see these; the
 *                            screen only fails when it runs (404).
 *
 * The gate runs these on the PR and on its base and fails on anything NEW,
 * so old debt is reported but never blamed on the PR that didn't add it.
 */
const fs = require('fs');
const path = require('path');

const CODE = /\.(jsx?|tsx?|mjs|cjs)$/;
const NOT_SOURCE = /\.(test|spec)\.|\.d\.ts$/;

/** Next.js loads these by file name, so nothing imports them. */
const NEXT_SPECIAL = /^(page|layout|loading|error|global-error|not-found|template|default|route|manifest|robots|sitemap|opengraph-image|twitter-image|icon|apple-icon)$/;

/**
 * The three apps. `alias` maps an import prefix to a folder; `src` is what
 * counts as the app's own code; `entries` are the files that run on their own.
 */
const APPS = {
  frontend: {
    dir: 'frontend',
    alias: { '@/': 'frontend/' },
    src: ['app', 'components', 'lib', 'hooks', 'data', 'content'],
    entries(root) {
      const app = path.join(root, 'frontend');
      const routed = listFiles(path.join(app, 'app'))
        .filter((f) => CODE.test(f) && NEXT_SPECIAL.test(path.basename(f).replace(/\.[^.]+$/, '')));
      const top = ['middleware', 'proxy', 'instrumentation', 'next.config']
        .map((n) => resolver(EXTS)(path.join(app, n))).filter(Boolean);
      // The service worker is compiled from next.config's swSrc (Serwist).
      const config = top.find((f) => /next\.config/.test(f));
      const sw = config && (fs.readFileSync(config, 'utf8').match(/swSrc:\s*['"]([^'"]+)['"]/) || [])[1];
      const swFile = sw && resolver(EXTS)(path.join(app, sw));
      return [...routed, ...top, ...(swFile ? [swFile] : [])];
    },
  },
  admin: {
    dir: 'backend/admin',
    alias: { '@/': 'backend/admin/src/' },
    src: ['src'],
    entries: (root) => [resolver(EXTS)(path.join(root, 'backend/admin/src/main'))].filter(Boolean),
  },
  backend: {
    dir: 'backend',
    alias: {},
    src: ['src'],
    /** The server, and everything run by hand or by the test runner. */
    entries(root) {
      const be = path.join(root, 'backend');
      const code = (d) => listFiles(path.join(be, d)).filter((f) => CODE.test(f));
      const topLevel = fs.existsSync(be)
        ? fs.readdirSync(be).filter((n) => CODE.test(n)).map((n) => path.join(be, n))
        : [];
      return [
        path.join(be, 'src/index.ts'),
        path.join(be, 'src/create-buckets.ts'),
        ...code('src/scripts'),
        ...code('scripts'),
        ...code('prisma'),
        ...code('test'),
        ...topLevel,
      ].filter((f) => fs.existsSync(f)).map((f) => path.normalize(f));
    },
  },
};

/** Where each app keeps its API client and data hooks. */
const API_DIRS = {
  frontend: ['frontend/lib/api', 'frontend/lib/hooks', 'frontend/hooks'],
  admin: ['backend/admin/src/hooks', 'backend/admin/src/config'],
};

const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function listFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) listFiles(p, out);
    else out.push(path.normalize(p));
  }
  return out;
}

function resolver(exts) {
  return (base) => {
    for (const e of exts) {
      const f = base + e;
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return path.normalize(f);
    }
    return null;
  };
}

const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

function sourceFiles(root, app) {
  const { dir, src } = APPS[app];
  return src.flatMap((d) => listFiles(path.join(root, dir, d)))
    .filter((f) => CODE.test(f) && !NOT_SOURCE.test(f));
}

/* Unused files */

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function unreachableFiles(root) {
  const resolve = resolver(EXTS);
  const out = [];
  for (const [name, app] of Object.entries(APPS)) {
    const target = (spec, from) => {
      for (const [prefix, to] of Object.entries(app.alias)) {
        if (spec.startsWith(prefix)) return path.join(root, to, spec.slice(prefix.length));
      }
      return spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
    };
    const seen = new Set();
    const walk = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      if (!CODE.test(file)) return;
      for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
        const t = target(m[1] || m[2] || m[3] || m[4], file);
        const hit = t && resolve(t);
        if (hit) walk(hit);
      }
    };
    app.entries(root).forEach(walk);
    for (const f of sourceFiles(root, name)) if (!seen.has(f)) out.push({ app: name, file: rel(root, f) });
  }
  return out;
}

/* Unused API functions and hooks */

function unusedApiExports(root) {
  const out = [];
  for (const [app, dirs] of Object.entries(API_DIRS)) {
    const files = sourceFiles(root, app);
    const tokens = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8').match(/[A-Za-z_$][\w$]*/g) || []]));
    const apiFiles = dirs.flatMap((d) => listFiles(path.join(root, d))).filter((f) => CODE.test(f) && !NOT_SOURCE.test(f));
    for (const file of apiFiles) {
      const src = fs.readFileSync(file, 'utf8');
      const names = new Set();
      for (const m of src.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
      for (const m of src.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
        for (const part of m[1].split(',')) {
          const n = part.trim().split(/\s+as\s+/).pop();
          if (n && n !== 'default' && !/^type\s/.test(part.trim())) names.add(n);
        }
      }
      const own = tokens.get(file) || src.match(/[A-Za-z_$][\w$]*/g) || [];
      for (const n of names) {
        const usedHere = own.filter((t) => t === n).length > 1;
        const usedElsewhere = [...tokens].some(([f, toks]) => f !== file && toks.includes(n));
        if (!usedHere && !usedElsewhere) out.push(`${n} ← ${rel(root, file)}`);
      }
    }
  }
  return out.sort();
}

/* API calls against the server's routes */

const PH = '\u0000'; // one ${…} in a template path

/** Every METHOD + path the Express app answers, from app.ts and the routers it mounts. */
function serverRoutes(root) {
  const appFile = path.join(root, 'backend/src/app.ts');
  if (!fs.existsSync(appFile)) return [];
  const src = fs.readFileSync(appFile, 'utf8');
  const resolve = resolver(EXTS);
  const routes = [];
  const strings = (lit) => [...lit.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
  const routeCalls = (code, ident) => new RegExp(`\\b${ident.replace(/\$/g, '\\$')}\\.(get|post|put|patch|delete|all)\\(\\s*(\\[[^\\]]*\\]|["'\`][^"'\`]+["'\`])`, 'g');

  // Routes declared on the app itself (/health, /api/stats).
  for (const m of src.matchAll(routeCalls(src, 'app'))) for (const p of strings(m[2])) routes.push([m[1].toUpperCase(), p]);

  // Routers imported from modules/, by local name.
  const imported = new Map();
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g)) imported.set(m[1], { from: m[2], name: 'default' });
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s+["']([^"']+)["']/g)) {
    for (const part of m[1].split(',')) {
      const [orig, local] = part.trim().split(/\s+as\s+/);
      if (orig) imported.set(local || orig, { from: m[2], name: orig });
    }
  }

  for (const m of src.matchAll(/app\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    const [, prefix, local] = m;
    const imp = imported.get(local);
    if (!imp || !imp.from.startsWith('.')) continue;
    const file = resolve(path.resolve(path.dirname(appFile), imp.from));
    if (!file) continue;
    const code = fs.readFileSync(file, 'utf8');
    const ident = imp.name === 'default' ? (code.match(/export\s+default\s+([A-Za-z_$][\w$]*)/) || [])[1] : imp.name;
    if (!ident) continue;
    for (const r of code.matchAll(routeCalls(code, ident))) {
      for (const p of strings(r[2])) routes.push([r[1].toUpperCase(), prefix + (p === '/' ? '' : p)]);
    }
  }

  // `:id?` is two routes; `:id(\d+)` is just `:id`.
  return routes.flatMap(([method, p]) => {
    const segs = p.split('/').filter(Boolean).map((s) => s.replace(/\(.*\)$/, ''));
    const opt = segs.findIndex((s) => s.endsWith('?'));
    if (opt === -1) return [[method, segs]];
    const clean = segs.map((s) => s.replace(/\?$/, ''));
    return [[method, clean], [method, clean.slice(0, opt).concat(clean.slice(opt + 1))]];
  });
}

/**
 * Read a string literal starting at `i` (the quote). Each ${…} becomes PH and
 * its expression is kept, so a leading `${base}` can be looked up.
 */
function readLiteral(src, i) {
  const q = src[i];
  let text = '';
  const exprs = [];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { text += src[j + 1] || ''; j++; continue; }
    if (c === q) return { text, exprs };
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      let depth = 1;
      const start = j + 2;
      j = start;
      while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; if (depth) j++; }
      exprs.push(src.slice(start, j).trim());
      text += PH;
      continue;
    }
    if (c === '\n' && q !== '`') return null;
    text += c;
  }
  return null;
}

/**
 * The path a call really hits. `${BASE_URL}/api/…` drops the origin, and a
 * leading `${base}` defined in the same file as a const string is filled in.
 * Anything else built from variables is returned as null: it cannot be checked.
 */
function callPath(src, lit) {
  let { text } = lit;
  if (text.startsWith(PH)) {
    const ident = lit.exprs[0];
    const def = /^[A-Za-z_$][\w$]*$/.test(ident)
      && src.match(new RegExp(`(?:const|let)\\s+${ident.replace(/\$/g, '\\$')}\\s*(?::[^=]+)?=\\s*(?=[\`'"])`));
    const value = def && readLiteral(src, def.index + def[0].length);
    if (value && value.text.startsWith('/')) text = value.text + text.slice(1);
    else if (text.slice(1).startsWith('/api')) text = text.slice(1);
    else return null;
  }
  return text.startsWith('/') ? text.split(/[?#]/)[0] : null;
}

function clientCalls(root) {
  const files = ['frontend', 'admin'].flatMap((a) => sourceFiles(root, a));
  const calls = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b[A-Za-z_$]*[aA]pi\.(get|post|put|patch|delete)\b/g)) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 400);
      const open = after.match(/^\s*(?:<[\s\S]*?>)?\s*\(\s*/);
      if (!open) continue;
      const q = m.index + m[0].length + open[0].length;
      if (!['"', "'", '`'].includes(src[q])) continue; // built from a variable: cannot check
      const lit = readLiteral(src, q);
      const p = lit && callPath(src, lit);
      if (!p) continue;
      const line = src.slice(0, m.index).split('\n').length;
      calls.push({ method: m[1].toUpperCase(), path: p, file: rel(root, f), line });
    }
  }
  return calls;
}

function matches(clientSegs, routeSegs) {
  if (clientSegs.length !== routeSegs.length && !routeSegs.includes('*')) return false;
  for (let i = 0; i < clientSegs.length; i++) {
    const r = routeSegs[i];
    if (r === undefined) return false;
    if (r === '*') return true;
    if (r.startsWith(':')) continue;
    const c = clientSegs[i];
    if (!c.includes(PH)) { if (c !== r) return false; continue; }
    // A placeholder inside a segment matches anything there, including a
    // trailing query string built elsewhere (`/api/jobs${qs}`).
    const re = new RegExp(`^${c.split(PH).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    if (!re.test(r)) return false;
  }
  return clientSegs.length === routeSegs.length;
}

/** Calls whose METHOD + path no server route answers. `key` ignores line numbers. */
function missingEndpoints(root) {
  const routes = serverRoutes(root);
  if (!routes.length) return [];
  const out = [];
  for (const c of clientCalls(root)) {
    const segs = c.path.split('/').filter(Boolean);
    const ok = routes.some(([method, r]) => (method === c.method || method === 'ALL') && matches(segs, r));
    if (ok) continue;
    const shown = c.path.split(PH).join('{…}');
    out.push({ key: `${c.method} ${shown} ← ${c.file}`, text: `${c.method} ${shown} ← ${c.file}:${c.line}` });
  }
  return out.sort((a, b) => a.text.localeCompare(b.text));
}

module.exports = { unreachableFiles, unusedApiExports, missingEndpoints, serverRoutes, clientCalls, APPS };
