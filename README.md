# Nunjucks Renderer

A minimal local development server for iterating on Nunjucks (`.njk`) templates in the browser with instant hot reload. No build step, no framework — just Express, Nunjucks, and a file watcher.

---

## What it does

- Renders any `.njk` template file to `http://localhost:3000`
- Watches the template, all its includes/extends/imports, and your mock data for changes
- Automatically reloads the browser the moment any watched file is saved — including `.less` or any other included file type
- Never crashes on missing or `undefined` template variables — they render as empty strings
- Supports `basePath` and other global variables used across templates, loaded from a `.env` file so local paths are never committed

---

## Prerequisites

- [Node.js](https://nodejs.org/) v16 or higher
- npm (comes with Node)

---

## Installation

```bash
# 1. Clone or copy this project to your machine
cd nunjucks-renderer

# 2. Install dependencies
npm install

# 3. Set up your local environment
cp .env.example .env
```

Then open `.env` and fill in your values (see [Configuration](#configuration) below).

---

## Usage

### Render the built-in example template

```bash
npm start
```

Opens `http://localhost:3000` and renders `templates/index.njk` using the mock data in `data/mock.js`.

### Render a template from anywhere on your machine

```bash
node server.js /absolute/path/to/your/template.njk

# or relative to the current directory:
node server.js ../../myproject/templates/email.njk
```

The server sets the template's own directory as the Nunjucks root, so relative includes (`{% include "./partial.njk" %}`) resolve correctly.

If the file does not exist the server exits immediately with a clear error.

---

## Configuration

### `.env` — local paths (git-ignored)

Copy `.env.example` to `.env` and set your machine-specific values:

```dotenv
# Absolute path to the shared template root used as `basePath` in templates.
# Must end with a trailing slash.
TEMPLATE_BASE_PATH=/Users/yourname/projects/myapp/src/templates/
```

This file is listed in `.gitignore` and will never be committed.

### `data/globals.js` — global template variables

Variables that should be available in every template render, regardless of which template is loaded. These are safe to commit — put machine-specific values in `.env` instead.

```js
module.exports = {
  basePath: process.env.TEMPLATE_BASE_PATH || '',
  // assetPath: process.env.ASSET_PATH || '/static/',
};
```

`globals.js` is watched for changes. Saving it reloads the browser automatically.

### `data/mock.js` — per-template mock data

Page-specific context passed to the template on every render. Edit freely — the browser reloads on save.

```js
module.exports = {
  title: 'My page',
  user: { name: 'Jane', role: 'Designer' },
  items: [{ label: 'Apple', count: 3 }],
};
```

Values in `mock.js` override same-named keys in `globals.js`.

---

## How hot reload works

```
Edit a .njk or .less file
        │
        ▼
  chokidar detects the change
        │
        ▼
  Server sends a message over
  Server-Sent Events (SSE)
        │
        ▼
  Tiny <script> in the page
  calls location.reload()
        │
        ▼
  Browser fetches / from the server
        │
        ▼
  Nunjucks re-reads all template
  files from disk (noCache: true)
  and returns fresh HTML
```

No WebSocket, no build pipeline. The injected script is ~3 lines and is stripped from any HTML you copy out of the browser.

### What triggers a reload

| File changed | Effect |
|---|---|
| The template you passed to the server | Reload |
| Any file it `{% include %}`s, `{% extends %}`, or `{% import %}`s | Reload |
| Any file included by those files (recursive) | Reload |
| `data/mock.js` | Reload + fresh data |
| `data/globals.js` | Reload + fresh globals + dep re-scan |
| `.less`, `.css`, or any other included file type | Reload |

If you add a new `{% include %}` while the server is running, it starts watching the new file automatically — no restart needed.

---

## Nunjucks features

### Undefined variables never crash

The engine is configured with `throwOnUndefined: false`. Missing variables and missing nested properties silently render as empty strings:

```njk
{{ missingVar }}           {# → "" #}
{{ user.name }}            {# → "" even if user is undefined #}
{{ ghost.nested.deep }}    {# → "" #}
```

### `| default` filter

Use `| default` to provide a fallback value:

```njk
{{ title | default("Untitled") }}
{{ user.role | default("Guest") }}
```

### `basePath` in extends / include

When your templates use a variable prefix to locate shared layouts:

```njk
{% extends basePath + "layouts/base.njk" %}
{% include basePath + "partials/header.njk" %}
{% import  basePath + "macros/linkTo.njk" as linkTo with context %}
```

Set `TEMPLATE_BASE_PATH` in `.env` to the absolute path of the shared template root (with trailing slash). The server adds this directory to Nunjucks' search paths so every absolute path resolves correctly.

---

## Project structure

```
nunjucks-renderer/
├── .env                  ← your local values (git-ignored)
├── .env.example          ← template for .env, safe to commit
├── .gitignore
├── package.json
├── server.js             ← Express server, Nunjucks config, watcher, SSE
├── data/
│   ├── globals.js        ← always-available template variables (commit this)
│   └── mock.js           ← per-template mock data (commit this)
└── templates/
    ├── index.njk         ← example entry template
    ├── _footer.njk       ← example include
    └── partials/
        └── _banner.njk   ← example include using basePath
```

---

## Tips

- **Point at a template in another project** — `node server.js ../myproject/src/views/email.njk`. The renderer never modifies that project.
- **Switch templates without restarting** — just `Ctrl+C` and rerun with a different path.
- **Copy rendered HTML** — the injected `<script>` tag is at the very bottom of `<body>`. Everything above it is your clean template output.
- **Template errors show in the browser** — a red `<pre>` block replaces the page, so you can see and fix Nunjucks errors without switching to the terminal.
