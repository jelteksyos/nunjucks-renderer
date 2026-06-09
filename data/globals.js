// Global template variables — merged into every render call.
//
// SENSITIVE VALUES (like basePath pointing to a local project directory)
// should be set in .env instead of here, so this file can be committed safely.
//
// Available environment variables (set in .env):
//   TEMPLATE_BASE_PATH   – used as `basePath` in templates
//
// Any variable defined here can still be overridden per-page in data/mock.js.

module.exports = {
  // Read basePath from the environment so the local path is never committed.
  // Set TEMPLATE_BASE_PATH in your .env file.
  basePath: process.env.TEMPLATE_BASE_PATH || '',

  // Add other always-available template variables here, e.g.:
  // assetPath: process.env.ASSET_PATH || '/static/',
};
