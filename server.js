'use strict';

// Load .env before anything else so process.env is populated for all modules.
require('dotenv').config();

const express = require('express');
const nunjucks = require('nunjucks');
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Resolve template path
//   node server.js                              → templates/index.njk (default)
//   node server.js /abs/path/to/file.njk        → that file
//   node server.js ../relative/path/file.njk    → resolved relative to cwd
// ---------------------------------------------------------------------------
const rawArg = process.argv[2];

let TEMPLATE_PATH;    // absolute path to the .njk file
let TEMPLATES_DIR;    // directory containing it (Nunjucks needs this)
let TEMPLATE_FILE;    // filename relative to TEMPLATES_DIR

if (rawArg) {
  TEMPLATE_PATH = path.resolve(process.cwd(), rawArg);
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`[error] Template not found: ${TEMPLATE_PATH}`);
    process.exit(1);
  }
  TEMPLATES_DIR = path.dirname(TEMPLATE_PATH);
  TEMPLATE_FILE = path.basename(TEMPLATE_PATH);
} else {
  TEMPLATES_DIR = path.join(__dirname, 'templates');
  TEMPLATE_FILE = 'index.njk';
  TEMPLATE_PATH = path.join(TEMPLATES_DIR, TEMPLATE_FILE);
}

const MOCK_DATA_PATH    = path.join(__dirname, 'data', 'mock.js');
const GLOBALS_DATA_PATH = path.join(__dirname, 'data', 'globals.js');

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------
function loadModule(absPath) {
  // Always bust the require cache so edits are picked up without a restart.
  delete require.cache[absPath];
  try {
    return require(absPath);
  } catch (err) {
    console.error(`[data] Failed to load ${path.relative(__dirname, absPath)}:`, err.message);
    return {};
  }
}

function loadContext() {
  const globals = loadModule(GLOBALS_DATA_PATH);
  const mock    = loadModule(MOCK_DATA_PATH);
  // globals can be overridden per-page by mock data if needed
  return Object.assign({}, globals, mock);
}

// ---------------------------------------------------------------------------
// Express + Nunjucks
// ---------------------------------------------------------------------------
const app = express();
const PORT = 3000;

// Build Nunjucks search paths.
//
// Nunjucks only resolves template names that resolve *within* a search path —
// absolute paths produced by  basePath + "some/file.njk"  would be rejected
// unless the basePath directory itself is listed here.
//
// Strategy:
//   1. The template's own directory   (for relative includes)
//   2. globals.basePath directory     (for  basePath + "..." expressions)
//   3. '/'  as final fallback         (catches any other absolute path)
//
// '/' is safe here — this server is intentionally local-dev only.
function buildSearchPaths() {
  const searchPaths = [TEMPLATES_DIR];

  try {
    // Load globals without busting the cache here — just a peek at basePath.
    const globals = require(GLOBALS_DATA_PATH);
    const bp = globals && globals.basePath;
    if (bp) {
      const resolved = path.resolve(bp);
      if (fs.existsSync(resolved) && !searchPaths.includes(resolved)) {
        searchPaths.push(resolved);
      }
    }
  } catch {
    // globals.js not yet written or has a syntax error — skip
  }

  // Root as final fallback so any absolute path is always resolvable.
  searchPaths.push('/');

  return searchPaths;
}

const searchPaths = buildSearchPaths();
const env = nunjucks.configure(searchPaths, {
  autoescape: true,
  throwOnUndefined: false, // missing vars render as "" instead of throwing
  noCache: true,           // re-read from disk on every request
  express: app,
});

// Register `default` filter explicitly (also built-in, but being explicit
// keeps template behaviour predictable and self-documenting).
env.addFilter('default', (value, fallback = '') => {
  if (value === undefined || value === null || value === '') return fallback;
  return value;
});

// ---------------------------------------------------------------------------
// SSE — Server-Sent Events for hot reload
// ---------------------------------------------------------------------------
let sseClients = [];

app.get('/__reload', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

function notifyClients() {
  sseClients.forEach((res) => res.write('data: reload\n\n'));
}

// Script injected into every rendered page.
const HOT_RELOAD_SCRIPT = `
<script>
  (function () {
    var es = new EventSource('/__reload');
    es.onmessage = function () { location.reload(); };
    es.onerror   = function () { es.close(); };
  })();
</script>`;

// ---------------------------------------------------------------------------
// Dependency scanner
//
// Recursively finds every file referenced by {% include %}, {% extends %},
// and {% import %} tags — including expressions that use variables.
//
// Supported expression forms:
//   "literal.njk"
//   'literal.njk'
//   varName + "suffix.njk"        (JS-style concat)
//   varName ~ "suffix.njk"        (Nunjucks-style concat)
//   "prefix/" + varName
//   "prefix/" ~ varName
//
// Variable values are resolved from `globals` (data/globals.js).
// Expressions that can't be resolved statically are logged as warnings.
// ---------------------------------------------------------------------------
function resolveDepExpr(expr, globals, baseDir) {
  const trimmed = expr.trim();

  // 1. Pure string literal
  const pureLit = trimmed.match(/^["']([^"']+)["']$/);
  if (pureLit) {
    return path.resolve(baseDir, pureLit[1]);
  }

  // 2. variable + "string"  or  variable ~ "string"
  const varFirst = trimmed.match(/^(\w+)\s*[+~]\s*["']([^"']*)["']$/);
  if (varFirst) {
    const val = globals[varFirst[1]];
    if (val !== undefined) return path.resolve(baseDir, String(val) + varFirst[2]);
    console.warn(`[deps] Can't resolve '${varFirst[1]}' — add it to data/globals.js`);
    return null;
  }

  // 3. "string" + variable  or  "string" ~ variable
  const strFirst = trimmed.match(/^["']([^"']*)["']\s*[+~]\s*(\w+)$/);
  if (strFirst) {
    const val = globals[strFirst[2]];
    if (val !== undefined) return path.resolve(baseDir, strFirst[1] + String(val));
    console.warn(`[deps] Can't resolve '${strFirst[2]}' — add it to data/globals.js`);
    return null;
  }

  // 4. variable + "mid" + variable  (rare but handle gracefully)
  console.warn(`[deps] Can't statically resolve expression: ${trimmed}`);
  return null;
}

function collectDeps(filePath, globals = {}, visited = new Set()) {
  if (visited.has(filePath)) return visited;
  visited.add(filePath);

  let src;
  try {
    src = fs.readFileSync(filePath, 'utf8');
  } catch {
    return visited; // file missing — skip silently
  }

  const dir = path.dirname(filePath);

  // Strip {% raw %}...{% endraw %} blocks so their contents are never scanned.
  const stripped = src.replace(/{%-?\s*raw\s*-?%}[\s\S]*?{%-?\s*endraw\s*-?%}/g, '');

  // Capture everything between the tag keyword and the closing %}
  const re = /{%-?\s*(?:include|extends|import)\s+([\s\S]*?)-?%}/g;
  let match;
  while ((match = re.exec(stripped)) !== null) {
    // Strip trailing whitespace and optional ignore/with/as clauses so we only
    // process the path expression.
    //   {% include "x.njk" ignore missing %}
    //   {% import "x.njk" as alias with context %}
    const rawExpr = match[1]
      .replace(/\s+ignore\s+missing\b.*/i, '')
      .replace(/\s+with\s+.*/i, '')
      .replace(/\s+as\s+.*/i, '')
      .trim();

    const dep = resolveDepExpr(rawExpr, globals, dir);
    if (dep) collectDeps(dep, globals, visited);
  }

  return visited;
}

// ---------------------------------------------------------------------------
// File watcher — template + all its deps + data/
// ---------------------------------------------------------------------------
function rescanDeps() {
  const globals = loadModule(GLOBALS_DATA_PATH);
  return collectDeps(TEMPLATE_PATH, globals);
}

let watchedTemplateDeps = rescanDeps();

// Log which deps were found at startup.
if (watchedTemplateDeps.size > 1) {
  console.log('Watching template deps:');
  for (const dep of watchedTemplateDeps) {
    console.log(`  ${dep}`);
  }
}

const watcher = chokidar.watch(
  [MOCK_DATA_PATH, GLOBALS_DATA_PATH, ...watchedTemplateDeps],
  { ignoreInitial: true }
);

watcher.on('change', (changedPath) => {
  console.log(`[reload] ${path.relative(process.cwd(), changedPath)}`);

  // Re-scan deps (globals may have changed, affecting variable-based paths).
  const newDeps = rescanDeps();

  for (const dep of newDeps) {
    if (!watchedTemplateDeps.has(dep)) {
      console.log(`[watch+] ${path.relative(process.cwd(), dep)}`);
      watcher.add(dep);
    }
  }

  for (const dep of watchedTemplateDeps) {
    if (!newDeps.has(dep)) {
      console.log(`[watch-] ${path.relative(process.cwd(), dep)}`);
      watcher.unwatch(dep);
    }
  }

  watchedTemplateDeps = newDeps;

  notifyClients();
});

// ---------------------------------------------------------------------------
// Main route
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  // Never cache the rendered page — every reload must hit the server so
  // Nunjucks re-reads all template files (including .less includes) from disk.
  res.setHeader('Cache-Control', 'no-store');

  const data = loadContext();

  let html;
  try {
    html = nunjucks.render(TEMPLATE_FILE, data);
  } catch (err) {
    console.error('[nunjucks]', err.message);
    html = `<pre style="color:red;padding:1rem">[Template error]\n${err.message}</pre>`;
  }

  // Inject hot-reload script just before </body>; fall back to appending.
  const injected = html.includes('</body>')
    ? html.replace('</body>', `${HOT_RELOAD_SCRIPT}</body>`)
    : html + HOT_RELOAD_SCRIPT;

  res.send(injected);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Nunjucks renderer  →  http://localhost:${PORT}`);
  console.log(`Template           →  ${TEMPLATE_PATH}`);
  console.log(`Mock data          →  ${MOCK_DATA_PATH}`);
  console.log(`Globals            →  ${GLOBALS_DATA_PATH}`);
  console.log(`Search paths       →  ${searchPaths.join(', ')}`);
});
