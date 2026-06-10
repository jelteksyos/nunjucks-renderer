'use strict';

// Load .env before anything else so process.env is populated for all modules.
require('dotenv').config();

const express = require('express');
const nunjucks = require('nunjucks');
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Resolve template path / email folder
//
//   node server.js                              → templates/index.njk (default)
//   node server.js /abs/path/to/file.njk        → that file
//   node server.js ../relative/path/file.njk    → resolved relative to cwd
//   node server.js /path/to/email-folder        → email-folder mode
//                                                  (folder contains nl/, en/, …
//                                                   each with html.njk + subject.njk)
// ---------------------------------------------------------------------------

// Returns the language sub-folder names that contain both html.njk and subject.njk.
function detectEmailFolderLangs(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => {
        const base = path.join(dirPath, e.name);
        return fs.existsSync(path.join(base, 'html.njk'))
            && fs.existsSync(path.join(base, 'subject.njk'));
      })
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const rawArg = process.argv[2];

// Mode: 'file' (default) | 'email-folder'
let MODE = 'file';

let TEMPLATE_PATH;    // absolute path to the .njk file  (file mode)
let TEMPLATES_DIR;    // directory containing it          (file mode)
let TEMPLATE_FILE;    // filename relative to TEMPLATES_DIR (file mode)

let EMAIL_FOLDER_PATH;   // absolute path to the folder    (email-folder mode)
let AVAILABLE_LANGS = []; // detected language sub-folders (email-folder mode)

if (rawArg) {
  const resolved = path.resolve(process.cwd(), rawArg);
  if (!fs.existsSync(resolved)) {
    console.error(`[error] Path not found: ${resolved}`);
    process.exit(1);
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const langs = detectEmailFolderLangs(resolved);
    if (langs.length === 0) {
      console.error(`[error] No email template folders found in: ${resolved}`);
      console.error(`        Expected sub-folders (e.g. nl/, en/) each containing html.njk and subject.njk`);
      process.exit(1);
    }
    MODE = 'email-folder';
    EMAIL_FOLDER_PATH = resolved;
    AVAILABLE_LANGS   = langs;
    // TEMPLATES_DIR used by buildSearchPaths() — point at folder root as a safe default.
    TEMPLATES_DIR = resolved;
  } else {
    TEMPLATE_PATH = resolved;
    TEMPLATES_DIR = path.dirname(resolved);
    TEMPLATE_FILE = path.basename(resolved);
  }
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
// Variable extraction helpers
// ---------------------------------------------------------------------------

// Nunjucks built-in names that are never context variables.
const NJK_GLOBALS   = new Set(['range', 'cycler', 'joiner']);
const NJK_BUILTINS  = new Set(['true', 'false', 'null', 'none', 'loop', 'caller']);

// Walk the Nunjucks AST and collect every context variable path used in src.
// Returns two Sets:
//   vars      — all dot-notation paths found (e.g. 'user.name', 'title')
//   iterables — paths that appear as the iterable of a {% for %} tag
function walkAst(src, vars, iterables) {
  let ast;
  try {
    ast = nunjucks.parser.parse(src);
  } catch {
    return; // syntax error in template — skip silently
  }

  const n = nunjucks.nodes;

  // Resolve a LookupVal chain to a dot-path string, or null if dynamic.
  function resolvePath(node) {
    if (node instanceof n.Symbol) return node.value;
    if (node instanceof n.LookupVal) {
      const t = resolvePath(node.target);
      if (t === null) return null;
      if (node.val instanceof n.Literal && typeof node.val.value === 'string') {
        return `${t}.${node.val.value}`;
      }
      return null; // dynamic key
    }
    return null;
  }

  function walk(node, locals) {
    if (!node || !(node instanceof n.Node)) return;

    // For / AsyncEach / AsyncAll — iterable is outer scope; loop var is local.
    if (node instanceof n.For) {
      // Record the iterable as an array-typed variable.
      const iterPath = resolvePath(node.arr);
      if (iterPath) {
        const root = iterPath.split('.')[0];
        if (!locals.has(root) && !NJK_GLOBALS.has(root) && !NJK_BUILTINS.has(root)) {
          iterables.add(iterPath);
        }
      } else {
        walk(node.arr, locals); // dynamic expression — walk it normally
      }

      const inner = new Set(locals);
      inner.add('loop');
      if (node.name instanceof n.Symbol) {
        inner.add(node.name.value);
      } else if (node.name instanceof n.Array) {
        node.name.children.forEach((c) => { if (c instanceof n.Symbol) inner.add(c.value); });
      }
      walk(node.body,  inner);
      walk(node.else_, locals);
      return;
    }

    // Set — RHS is evaluated before the name exists; don't add target to locals
    // (it may still be read from context later, so we let it pass through).
    if (node instanceof n.Set) {
      walk(node.value, locals);
      walk(node.body,  locals);
      return;
    }

    // Macro / Caller — args are local inside the macro body.
    if (node instanceof n.Macro) {
      const inner = new Set(locals);
      inner.add('caller');
      node.args.children.forEach((arg) => {
        if (arg instanceof n.Symbol) {
          inner.add(arg.value);
        } else if (arg instanceof n.Dict) {
          arg.children.forEach((p) => { if (p.key instanceof n.Symbol) inner.add(p.key.value); });
        }
      });
      walk(node.body, inner);
      return;
    }

    // Import / FromImport — aliases are local, not context reads.
    if (node instanceof n.Import || node instanceof n.FromImport) return;

    // Block — node.name is a block label, not a variable.
    if (node instanceof n.Block) { walk(node.body, locals); return; }

    // Filter — node.name is a filter identifier, not a variable.
    if (node instanceof n.Filter) { walk(node.args, locals); return; }

    // Symbol — a plain variable read.
    if (node instanceof n.Symbol) {
      const name = node.value;
      if (!locals.has(name) && !NJK_GLOBALS.has(name) && !NJK_BUILTINS.has(name)) {
        vars.add(name);
      }
      return;
    }

    // LookupVal — dotted access like user.name.
    if (node instanceof n.LookupVal) {
      const dotPath = resolvePath(node);
      if (dotPath !== null) {
        const root = dotPath.split('.')[0];
        if (!locals.has(root) && !NJK_GLOBALS.has(root) && !NJK_BUILTINS.has(root)) {
          vars.add(dotPath);
        }
      } else {
        // Dynamic key — walk both sides so dynamic-key exprs are captured.
        walk(node.target, locals);
        walk(node.val,    locals);
      }
      return;
    }

    // Default: recurse into all fields.
    if (node instanceof n.NodeList) {
      node.children.forEach((c) => walk(c, locals));
    } else {
      node.fields.forEach((field) => {
        const child = node[field];
        if (child instanceof n.Node) walk(child, locals);
      });
    }
  }

  walk(ast, new Set());
}

// Given an array of template file paths (entry + deps), extract all context
// variable paths and classify them as 'string' | 'array'.
// Only leaf paths are returned — intermediate objects (e.g. 'user' when
// 'user.name' exists) are omitted; they'll be grouped in the UI.
function extractTemplateVars(filePaths) {
  const rawVars   = new Set(); // all dot-paths found
  const iterables = new Set(); // paths that are for-loop iterables → array type

  for (const fp of filePaths) {
    let src;
    try { src = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    walkAst(src, rawVars, iterables);
  }

  // Remove root-only paths that also have deeper accesses
  // e.g. if we have both 'user' and 'user.name', drop the bare 'user'.
  const dominated = new Set();
  for (const p of rawVars) {
    for (const q of rawVars) {
      if (q !== p && q.startsWith(p + '.')) dominated.add(p);
    }
  }

  const result = [];
  for (const p of rawVars) {
    if (dominated.has(p)) continue; // intermediate node — skip
    result.push({ path: p, type: iterables.has(p) ? 'array' : 'string' });
  }

  // Stable sort: group by root name, then alphabetically within group.
  result.sort((a, b) => {
    const ar = a.path.split('.')[0];
    const br = b.path.split('.')[0];
    if (ar !== br) return ar.localeCompare(br);
    return a.path.localeCompare(b.path);
  });

  return result;
}

// Expand { 'user.name': 'Jane', 'title': 'Hi', 'items': '[{"x":1}]' }
// into   { user: { name: 'Jane' }, title: 'Hi', items: [{ x: 1 }] }.
// Values that look like JSON are parsed; everything else stays a string.
function expandDotPaths(flat) {
  const result = {};
  for (const [dotPath, raw] of Object.entries(flat)) {
    const parts = dotPath.split('.');
    let obj = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (obj[parts[i]] == null || typeof obj[parts[i]] !== 'object') {
        obj[parts[i]] = {};
      }
      obj = obj[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (typeof raw === 'string' && raw.trim() !== '') {
      try { obj[leaf] = JSON.parse(raw); } catch { obj[leaf] = raw; }
    } else {
      obj[leaf] = raw;
    }
  }
  return result;
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
  // TEMPLATES_DIR is undefined in email-folder mode — skip it.
  const searchPaths = TEMPLATES_DIR ? [TEMPLATES_DIR] : [];

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

// Build a fresh Nunjucks environment for a specific language directory.
// Used in email-folder mode so each language gets isolated search paths.
function buildEmailEnv(langDir) {
  const searchPaths = [langDir, EMAIL_FOLDER_PATH];

  try {
    const globals = require(GLOBALS_DATA_PATH);
    const bp = globals && globals.basePath;
    if (bp) {
      const resolved = path.resolve(bp);
      if (fs.existsSync(resolved) && !searchPaths.includes(resolved)) {
        searchPaths.push(resolved);
      }
    }
  } catch {}

  // Root as final fallback so absolute paths always resolve.
  searchPaths.push('/');

  const loader = new nunjucks.FileSystemLoader(searchPaths, { noCache: true });
  const emailEnv = new nunjucks.Environment(loader, {
    autoescape: true,
    throwOnUndefined: false,
  });

  emailEnv.addFilter('default', (value, fallback = '') => {
    if (value === undefined || value === null || value === '') return fallback;
    return value;
  });

  return emailEnv;
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
// Shell UI helpers — shared between file mode and email-folder mode
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Escape for use as a double-quoted HTML attribute value.
// srcdoc only needs & and " escaped — < and > must stay as markup.
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

// Shared CSS for the toolbar, tab buttons, panel, and form fields.
// Used by both shells so the panel looks identical in both modes.
const SHELL_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body { font-family: system-ui, sans-serif; background: #f3f4f6;
         display: flex; flex-direction: column; }

  /* toolbar */
  .toolbar {
    display: flex; align-items: center; gap: 4px;
    background: #1e1e2e; padding: 8px 14px; flex-shrink: 0;
  }
  .toolbar-label {
    font-size: 11px; font-weight: 600; color: #6b7280;
    text-transform: uppercase; letter-spacing: .06em; margin-right: 6px;
  }
  .toolbar-spacer { flex: 1; }

  /* language + toggle tabs */
  .tab, #__njk-toggle {
    display: inline-block; padding: 4px 12px; font-size: 12px;
    font-weight: 600; text-decoration: none; color: #9ca3af;
    border-radius: 5px; transition: background .1s, color .1s;
    cursor: pointer; background: none; border: none; font-family: inherit;
  }
  .tab:hover, #__njk-toggle:hover { background: #2d2d40; color: #e5e7eb; }
  .tab.active, #__njk-toggle.active { background: #6366f1; color: #fff; }

  /* subject bar (email-folder mode) */
  .subject-bar {
    display: flex; align-items: baseline; gap: 8px;
    background: #fff; border-bottom: 1px solid #e5e7eb;
    padding: 8px 14px; flex-shrink: 0;
  }
  .subject-label {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .08em; color: #9ca3af; flex-shrink: 0;
  }
  .subject-value { font-size: 14px; color: #111827; }

  /* main area: iframe + panel side by side */
  .main { display: flex; flex: 1; overflow: hidden; }
  #__njk-frame { flex: 1; border: none; background: #fff; min-width: 0; }

  /* variables panel */
  #__njk-panel {
    width: 280px; flex-shrink: 0; background: #1a1a2e;
    border-left: 1px solid #2d2d40; display: flex; flex-direction: column;
    overflow: hidden;
  }
  #__njk-panel[hidden] { display: none; }
  #__njk-panel-hdr {
    padding: 10px 12px 8px; font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .07em; color: #6b7280;
    border-bottom: 1px solid #2d2d40; flex-shrink: 0;
  }
  #__njk-fields {
    flex: 1; overflow-y: auto; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 12px;
  }

  /* field groups */
  .__njk-group { display: flex; flex-direction: column; gap: 6px; }
  .__njk-group-hdr {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .07em; color: #6366f1; margin-bottom: 2px;
  }
  .__njk-row { display: flex; flex-direction: column; gap: 3px; }
  .__njk-row label {
    font-size: 11px; color: #9ca3af; user-select: none;
  }
  .__njk-row input, .__njk-row textarea {
    background: #0f0f1a; color: #e5e7eb; border: 1px solid #2d2d40;
    border-radius: 4px; padding: 5px 7px; font-size: 12px;
    font-family: ui-monospace, monospace; width: 100%; resize: vertical;
    transition: border-color .15s;
  }
  .__njk-row input:focus, .__njk-row textarea:focus {
    outline: none; border-color: #6366f1;
  }
  .__njk-row textarea { min-height: 72px; }
`;

// Build the Variables panel HTML (shared between both shells).
function panelHtml() {
  return `
  <div id="__njk-panel" hidden>
    <div id="__njk-panel-hdr">Variables</div>
    <div id="__njk-fields"></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// buildEmailShell — email-folder mode page wrapper
// ---------------------------------------------------------------------------
function buildEmailShell({ lang, langs, subject, htmlBody }) {
  const tabs = langs
    .map((l) => {
      const active = l === lang ? ' active' : '';
      return `<a href="/?lang=${l}" class="tab${active}">${escapeHtml(l.toUpperCase())}</a>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Email preview — ${escapeHtml(lang.toUpperCase())}</title>
  <style>${SHELL_CSS}</style>
</head>
<body>
  <div class="toolbar">
    <span class="toolbar-label">Language</span>
    ${tabs}
    <span class="toolbar-spacer"></span>
    <button id="__njk-toggle" title="Toggle variables panel">Variables</button>
  </div>
  <div class="subject-bar">
    <span class="subject-label">Subject</span>
    <span id="__njk-subject-value" class="subject-value">${escapeHtml(subject)}</span>
  </div>
  <div class="main">
    <iframe id="__njk-frame" srcdoc="${escapeAttr(htmlBody)}" title="Email preview"></iframe>
    ${panelHtml()}
  </div>
  <script>window.__NJK_CONFIG = { mode: 'email-folder', lang: ${JSON.stringify(lang)} };</script>
  ${PANEL_SCRIPT}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// buildFileShell — single-file mode page wrapper
// ---------------------------------------------------------------------------
function buildFileShell({ title, htmlBody }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${SHELL_CSS}</style>
</head>
<body>
  <div class="toolbar">
    <span class="toolbar-label">${escapeHtml(title)}</span>
    <span class="toolbar-spacer"></span>
    <button id="__njk-toggle" title="Toggle variables panel">Variables</button>
  </div>
  <div class="main">
    <iframe id="__njk-frame" srcdoc="${escapeAttr(htmlBody)}" title="Template preview"></iframe>
    ${panelHtml()}
  </div>
  <script>window.__NJK_CONFIG = { mode: 'file', lang: null };</script>
  ${PANEL_SCRIPT}
</body>
</html>`;
}

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

// Script injected into every rendered page (panel-less fallback only).
// In practice the shell pages use PANEL_SCRIPT which has its own SSE handler.
const HOT_RELOAD_SCRIPT = `
<script>
  (function () {
    var es = new EventSource('/__reload');
    es.onmessage = function () { location.reload(); };
    es.onerror   = function () { es.close(); };
  })();
</script>`;

// ---------------------------------------------------------------------------
// Variables API  —  GET /__vars[?lang=xx]
// ---------------------------------------------------------------------------
app.get('/__vars', (req, res) => {
  let filePaths = [];

  if (MODE === 'email-folder') {
    const lang = (req.query.lang && AVAILABLE_LANGS.includes(req.query.lang))
      ? req.query.lang
      : AVAILABLE_LANGS[0];
    const langDir = path.join(EMAIL_FOLDER_PATH, lang);
    const globals = loadModule(GLOBALS_DATA_PATH);
    const visited = new Set();
    collectDeps(path.join(langDir, 'html.njk'),    globals, visited);
    collectDeps(path.join(langDir, 'subject.njk'), globals, visited);
    filePaths = [...visited];
  } else {
    const globals = loadModule(GLOBALS_DATA_PATH);
    filePaths = [...collectDeps(TEMPLATE_PATH, globals)];
  }

  res.json({ vars: extractTemplateVars(filePaths) });
});

// ---------------------------------------------------------------------------
// Render API  —  POST /__render
// Body: { lang?: string, vars: { 'dot.path': 'value', ... } }
// Returns: { html: string, subject?: string }
// ---------------------------------------------------------------------------
app.use(express.json());

app.post('/__render', (req, res) => {
  const { lang: reqLang, vars: flatVars = {} } = req.body || {};

  // Build context: globals only (mock.js bypassed) + expanded form values.
  const globals   = loadModule(GLOBALS_DATA_PATH);
  const formCtx   = expandDotPaths(flatVars);
  const data      = Object.assign({}, globals, formCtx);

  if (MODE === 'email-folder') {
    const lang    = (reqLang && AVAILABLE_LANGS.includes(reqLang))
      ? reqLang
      : AVAILABLE_LANGS[0];
    data.lang     = lang;
    const langDir = path.join(EMAIL_FOLDER_PATH, lang);
    const emailEnv = buildEmailEnv(langDir);

    let subject = '';
    try {
      subject = emailEnv.render(path.join(langDir, 'subject.njk'), data).trim();
    } catch (err) {
      subject = `[subject error: ${err.message}]`;
    }

    let html = '';
    try {
      html = emailEnv.render(path.join(langDir, 'html.njk'), data);
    } catch (err) {
      html = `<pre style="color:red;padding:1rem">[Template error]\n${err.message}</pre>`;
    }

    res.json({ html, subject });
  } else {
    let html = '';
    try {
      html = nunjucks.render(TEMPLATE_FILE, data);
    } catch (err) {
      html = `<pre style="color:red;padding:1rem">[Template error]\n${err.message}</pre>`;
    }
    res.json({ html });
  }
});

// ---------------------------------------------------------------------------
// Panel script — injected into every shell page.
// Provides: SSE-aware hot reload, variable form, live re-render.
// ---------------------------------------------------------------------------
const PANEL_SCRIPT = `
<script>
(function () {
  /* ── state ─────────────────────────────────────────────────── */
  var cfg     = window.__NJK_CONFIG || { mode: 'file', lang: null };
  var panelOpen   = false;
  var formValues  = {};   // { 'dot.path': 'raw string value' }
  var debounceTimer = null;

  /* ── SSE hot reload ─────────────────────────────────────────── */
  var es = new EventSource('/__reload');
  es.onmessage = function () {
    if (panelOpen && Object.keys(formValues).length > 0) {
      doRender();          // re-render with current form values
    } else {
      location.reload();   // plain reload — mock.js will be used
    }
  };
  es.onerror = function () { es.close(); };

  /* ── DOM refs (set after DOMContentLoaded) ──────────────────── */
  var toggleBtn, panel, fieldsEl, iframe, subjectEl;

  document.addEventListener('DOMContentLoaded', function () {
    toggleBtn = document.getElementById('__njk-toggle');
    panel     = document.getElementById('__njk-panel');
    fieldsEl  = document.getElementById('__njk-fields');
    iframe    = document.getElementById('__njk-frame');
    subjectEl = document.getElementById('__njk-subject-value');

    toggleBtn.addEventListener('click', function () {
      panelOpen = !panelOpen;
      panel.hidden = !panelOpen;
      toggleBtn.classList.toggle('active', panelOpen);
      if (panelOpen && fieldsEl.children.length === 0) loadVars();
    });
  });

  /* ── load variable list and build form ──────────────────────── */
  function loadVars() {
    var url = '/__vars' + (cfg.lang ? '?lang=' + cfg.lang : '');
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) { buildForm(data.vars || []); })
      .catch(function (e) {
        fieldsEl.innerHTML = '<p style="color:#f87171;font-size:12px">Failed to load variables: ' + e.message + '</p>';
      });
  }

  /* ── build form fields ──────────────────────────────────────── */
  function buildForm(vars) {
    if (vars.length === 0) {
      fieldsEl.innerHTML = '<p style="font-size:12px;color:#9ca3af;margin-top:4px">No template variables detected.</p>';
      return;
    }

    fieldsEl.innerHTML = '';

    /* group vars under their root name */
    var groups = {};
    vars.forEach(function (v) {
      var root = v.path.split('.')[0];
      if (!groups[root]) groups[root] = [];
      groups[root].push(v);
    });

    Object.keys(groups).sort().forEach(function (root) {
      var items = groups[root];
      var groupEl = document.createElement('div');
      groupEl.className = '__njk-group';

      if (items.length > 1 || items[0].path !== root) {
        var hdr = document.createElement('div');
        hdr.className = '__njk-group-hdr';
        hdr.textContent = root;
        groupEl.appendChild(hdr);
      }

      items.forEach(function (v) {
        var label = v.path.includes('.') ? v.path.split('.').slice(1).join('.') : v.path;
        var row = document.createElement('div');
        row.className = '__njk-row';

        var lbl = document.createElement('label');
        lbl.textContent = label;
        lbl.htmlFor = '__njk-f-' + v.path;

        var input;
        if (v.type === 'array') {
          input = document.createElement('textarea');
          input.rows = 4;
          input.placeholder = '[{"key": "value"}]';
        } else {
          input = document.createElement('input');
          input.type = 'text';
          input.placeholder = label;
        }
        input.id = '__njk-f-' + v.path;
        input.dataset.path = v.path;

        input.addEventListener('input', function () {
          formValues[v.path] = input.value;
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(doRender, 300);
        });

        row.appendChild(lbl);
        row.appendChild(input);
        groupEl.appendChild(row);
      });

      fieldsEl.appendChild(groupEl);
    });
  }

  /* ── send render request and update iframe ──────────────────── */
  function doRender() {
    var body = { vars: formValues };
    if (cfg.lang) body.lang = cfg.lang;

    fetch('/__render', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (iframe)    iframe.srcdoc  = data.html    || '';
        if (subjectEl) subjectEl.textContent = data.subject || '';
      })
      .catch(function (e) { console.error('[njk-panel] render error', e); });
  }
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
  if (MODE === 'email-folder') {
    const visited = new Set();
    for (const lang of AVAILABLE_LANGS) {
      const langDir = path.join(EMAIL_FOLDER_PATH, lang);
      collectDeps(path.join(langDir, 'html.njk'),    globals, visited);
      collectDeps(path.join(langDir, 'subject.njk'), globals, visited);
    }
    return visited;
  }
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
  // Never cache — every reload must hit the server fresh.
  res.setHeader('Cache-Control', 'no-store');

  // ------------------------------------------------------------------
  // Email-folder mode
  // ------------------------------------------------------------------
  if (MODE === 'email-folder') {
    const lang = (req.query.lang && AVAILABLE_LANGS.includes(req.query.lang))
      ? req.query.lang
      : AVAILABLE_LANGS[0];

    const langDir  = path.join(EMAIL_FOLDER_PATH, lang);
    const emailEnv = buildEmailEnv(langDir);
    const data     = loadContext();
    data.lang      = lang;

    let subject = '';
    try {
      subject = emailEnv.render(path.join(langDir, 'subject.njk'), data).trim();
    } catch (err) {
      console.error('[nunjucks:subject]', err.message);
      subject = `[subject error: ${err.message}]`;
    }

    let htmlBody = '';
    try {
      htmlBody = emailEnv.render(path.join(langDir, 'html.njk'), data);
    } catch (err) {
      console.error('[nunjucks:html]', err.message);
      htmlBody = `<pre style="color:red;padding:1rem">[Template error]\n${err.message}</pre>`;
    }

    res.send(buildEmailShell({ lang, langs: AVAILABLE_LANGS, subject, htmlBody }));
    return;
  }

  // ------------------------------------------------------------------
  // File mode
  // ------------------------------------------------------------------
  const data = loadContext();

  let htmlBody = '';
  try {
    htmlBody = nunjucks.render(TEMPLATE_FILE, data);
  } catch (err) {
    console.error('[nunjucks]', err.message);
    htmlBody = `<pre style="color:red;padding:1rem">[Template error]\n${err.message}</pre>`;
  }

  res.send(buildFileShell({ title: TEMPLATE_FILE, htmlBody }));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Nunjucks renderer  →  http://localhost:${PORT}`);
  if (MODE === 'email-folder') {
    console.log(`Mode               →  email-folder`);
    console.log(`Folder             →  ${EMAIL_FOLDER_PATH}`);
    console.log(`Languages          →  ${AVAILABLE_LANGS.join(', ')}`);
  } else {
    console.log(`Template           →  ${TEMPLATE_PATH}`);
  }
  console.log(`Mock data          →  ${MOCK_DATA_PATH}`);
  console.log(`Globals            →  ${GLOBALS_DATA_PATH}`);
  console.log(`Search paths       →  ${searchPaths.join(', ')}`);
});
