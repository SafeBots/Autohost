// src/engines/nginx.js
//
// nginx engine. Renders per-host vhosts from a template (configurable via
// cfg.vhostTemplatePath, defaults to /etc/autohost/vhost-template.conf if
// it exists, else the DEFAULT_TEMPLATE below).
//
// Provides:
//   - vhostConfigFor(host, certPath, keyPath, opts) → string
//   - validateConfig() → Promise<{ok, stderr}>   (runs nginx -t)
//   - reload() → Promise<{ok, stderr}>           (runs nginx -s reload)
//
// All nginx-specific knowledge lives here. autohost.js dispatches to
// whichever engine is configured.

'use strict';

const { execFile } = require('child_process');
const templates = require('../templates');

// Built-in default template. Used when no operator template file is
// installed. Keeps the project usable out-of-the-box without requiring
// operators to manage an external file.
const DEFAULT_TEMPLATE = `server {
    listen 443 ssl http2;
    server_name {{hostname}};

    ssl_certificate     {{certPath}};
    ssl_certificate_key {{keyPath}};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    # HSTS is intentionally NOT set by default. Adding it locks browsers into
    # HTTPS for this hostname for a year, which breaks the "first visit can
    # happen cleanly over HTTP" property that autohost relies on. Operators
    # who want HSTS should add it in their custom vhost template only AFTER
    # confirming the TLS setup is stable across their fleet.

    location /.well-known/acme-challenge/ {
        root {{acmeChallengesRoot}};
        default_type text/plain;
    }

    location / {
        proxy_pass         http://{{proxyTarget}};
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_set_header   X-Forwarded-Host $host;
        proxy_set_header   Connection "";
        proxy_read_timeout 60s;
        proxy_buffering    off;
    }
}

server {
    listen 80;
    server_name {{hostname}};

    location /.well-known/acme-challenge/ {
        root {{acmeChallengesRoot}};
        default_type text/plain;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}
`;

function create(cfg) {
    function vhostConfigFor(host, certPath, keyPath, opts) {
        opts = opts || {};
        const proxyTarget = opts.proxyTarget || cfg.proxyTarget;

        const header = `# Auto-provisioned by autohost on ${new Date().toISOString()}\n` +
                       `# Hostname: ${host}\n` +
                       `# Provider: ${cfg.provider}\n`;

        const body = templates.render('nginx', cfg.vhostTemplatePath, DEFAULT_TEMPLATE, {
            hostname:           host,
            certPath:           certPath,
            keyPath:            keyPath,
            proxyTarget:        proxyTarget,
            acmeChallengesRoot: cfg.acmeChallengesRoot,
        });

        return header + body;
    }

    function validateConfig() {
        return new Promise((resolve) => {
            execFile(cfg.nginxBinary, ['-t'], { timeout: 10000 }, (err, stdout, stderr) => {
                resolve({ ok: !err, stderr: (stderr || '').slice(0, 512) });
            });
        });
    }

    function reload() {
        return new Promise((resolve) => {
            execFile(cfg.nginxBinary, ['-s', 'reload'], { timeout: 10000 }, (err, stdout, stderr) => {
                resolve({ ok: !err, stderr: (stderr || '').slice(0, 256) });
            });
        });
    }

    return {
        name: 'nginx',
        vhostConfigFor,
        validateConfig,
        reload,
        vhostFileExtension: '.conf',
        _defaultTemplate: DEFAULT_TEMPLATE,  // for tests
    };
}

module.exports = { create, DEFAULT_TEMPLATE };
