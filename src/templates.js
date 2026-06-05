// src/templates.js
//
// Per-host vhost template loader. Reads a template file at startup and
// substitutes {{placeholders}} at provisioning time. Falls back to the
// engine's built-in default if no template file is configured or the
// configured file is missing.
//
// Operator workflow:
//   1. Edit /etc/autohost/vhost-template.conf (whatever path config points at)
//   2. systemctl restart autohost
//   3. New provisions use the new template
//   4. Existing provisions stay as-is until they're regenerated
//
// Template syntax: {{placeholder}}. Multiple occurrences all replaced.
// Unknown placeholders left alone (so $variable / %{VAR} from nginx/Apache
// pass through unaltered).

'use strict';

const fs = require('fs');

// Cache compiled templates per (engine, path) so we don't re-read the file
// on every provision. Cleared by reloadAll().
const cache = new Map();

function cacheKey(engineName, templatePath) {
    return `${engineName}::${templatePath || '<default>'}`;
}

function readTemplate(templatePath) {
    if (!templatePath) return null;
    try {
        return fs.readFileSync(templatePath, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
}

// Substitute {{placeholder}} tokens. Tokens not in the values object are
// left alone — important because both nginx and Apache use $variable /
// %{VAR} forms that look superficially like templating but aren't ours.
function substitute(template, values) {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
            return values[key];
        }
        return match;  // unknown placeholder, leave alone
    });
}

// Load a template for an engine, with fallback to engine's built-in default.
// Returns the template string (substitution happens later in render()).
function loadTemplate(engineName, templatePath, defaultTemplate) {
    const key = cacheKey(engineName, templatePath);
    if (cache.has(key)) return cache.get(key);

    const fromFile = readTemplate(templatePath);
    const template = fromFile !== null ? fromFile : defaultTemplate;
    cache.set(key, template);
    return template;
}

// Render a per-host vhost config for the given engine + values.
//   engineName:      'nginx' | 'apache'
//   templatePath:    optional file path (from cfg.vhostTemplatePath)
//   defaultTemplate: fallback template if file missing or path null
//   values:          object with hostname/certPath/keyPath/proxyTarget/acmeChallengesRoot
function render(engineName, templatePath, defaultTemplate, values) {
    const template = loadTemplate(engineName, templatePath, defaultTemplate);
    return substitute(template, values);
}

// Test/operational helper: drop cached templates so next render() re-reads.
function reloadAll() {
    cache.clear();
}

module.exports = {
    render,
    reloadAll,
    _substitute:    substitute,
    _readTemplate:  readTemplate,
    _loadTemplate:  loadTemplate,
};
