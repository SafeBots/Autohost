// src/engines/apache.js
//
// Apache HTTP Server engine. Renders per-host VirtualHost blocks from a
// template (configurable via cfg.vhostTemplatePath, defaults to
// /etc/autohost/vhost-template.conf, else the DEFAULT_TEMPLATE below).
//
// Apache support is for users who want autohost's multi-provider
// abstraction (Let's Encrypt + Cloudflare Origin CA + CloudFront origin
// certs) on Apache. If you only need Let's Encrypt on Apache, mod_md does
// ACME natively and is built into Apache 2.4.30+.

'use strict';

const { execFile } = require('child_process');
const templates = require('../templates');

const DEFAULT_TEMPLATE = `<VirtualHost *:443>
    ServerName {{hostname}}

    SSLEngine on
    SSLCertificateFile      {{certPath}}
    SSLCertificateKeyFile   {{keyPath}}
    SSLProtocol             -all +TLSv1.2 +TLSv1.3
    SSLCipherSuite          HIGH:!aNULL:!MD5
    SSLHonorCipherOrder     on

    Header always set X-Content-Type-Options "nosniff"
    Header always set X-Frame-Options "SAMEORIGIN"
    Header always set Referrer-Policy "strict-origin-when-cross-origin"
    # HSTS intentionally NOT set by default. See nginx engine for rationale.

    Alias /.well-known/acme-challenge/ "{{acmeChallengesRoot}}/.well-known/acme-challenge/"
    <Directory "{{acmeChallengesRoot}}/.well-known/acme-challenge/">
        Require all granted
        Options None
    </Directory>

    ProxyPreserveHost On
    ProxyRequests Off
    ProxyPass         /.well-known/acme-challenge/ !
    ProxyPass         / http://{{proxyTarget}}/
    ProxyPassReverse  / http://{{proxyTarget}}/

    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Host "%{HTTP_HOST}s"
</VirtualHost>

<VirtualHost *:80>
    ServerName {{hostname}}

    Alias /.well-known/acme-challenge/ "{{acmeChallengesRoot}}/.well-known/acme-challenge/"
    <Directory "{{acmeChallengesRoot}}/.well-known/acme-challenge/">
        Require all granted
        Options None
    </Directory>

    RewriteEngine On
    RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/
    RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>
`;

function create(cfg) {
    function vhostConfigFor(host, certPath, keyPath, opts) {
        opts = opts || {};
        const proxyTarget = opts.proxyTarget || cfg.proxyTarget;

        const header = `# Auto-provisioned by autohost on ${new Date().toISOString()}\n` +
                       `# Hostname: ${host}\n` +
                       `# Provider: ${cfg.provider}\n`;

        const body = templates.render('apache', cfg.vhostTemplatePath, DEFAULT_TEMPLATE, {
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
            execFile(cfg.apacheBinary, ['configtest'], { timeout: 10000 }, (err, stdout, stderr) => {
                resolve({ ok: !err, stderr: (stderr || '').slice(0, 512) });
            });
        });
    }

    function reload() {
        return new Promise((resolve) => {
            execFile(cfg.apacheBinary, ['graceful'], { timeout: 10000 }, (err, stdout, stderr) => {
                resolve({ ok: !err, stderr: (stderr || '').slice(0, 256) });
            });
        });
    }

    return {
        name: 'apache',
        vhostConfigFor,
        validateConfig,
        reload,
        vhostFileExtension: '.conf',
        _defaultTemplate: DEFAULT_TEMPLATE,
    };
}

module.exports = { create, DEFAULT_TEMPLATE };
