// test/testTemplates.js
//
// Tests the template loader + substitution. Covers:
//   1. Pure substitute() behavior: placeholders replaced, unknowns passed through
//   2. Template file loading + caching
//   3. Falls back to engine default when file is missing
//   4. Both engines render correctly with a custom template
//   5. {{hostname}} works in multiple positions
//   6. nginx $variable and Apache %{VAR} pass through unaltered

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

const templates = require('../src/templates');

// ── Pure substitute() ────────────────────────────────────────────────────────
check('substitute replaces single placeholder',
    templates._substitute('Hello {{name}}!', { name: 'world' }) === 'Hello world!');

check('substitute replaces multiple occurrences',
    templates._substitute('{{x}} and {{x}}', { x: 'A' }) === 'A and A');

check('substitute leaves unknown placeholders alone',
    templates._substitute('{{known}} {{unknown}}', { known: 'foo' }) === 'foo {{unknown}}');

check('substitute leaves nginx $variables alone',
    templates._substitute('proxy_pass $upstream;', {}) === 'proxy_pass $upstream;');

check('substitute leaves Apache %{VARS} alone',
    templates._substitute('RequestHeader set X-H "%{HTTP_HOST}s"', {}) ===
    'RequestHeader set X-H "%{HTTP_HOST}s"');

check('substitute handles empty values object',
    templates._substitute('{{x}}', {}) === '{{x}}');

check('substitute handles values with special regex chars',
    templates._substitute('cert={{certPath}}', { certPath: '/etc/$auto/c.crt' }) ===
    'cert=/etc/$auto/c.crt');

check('substitute replaces in multi-line',
    templates._substitute('a\n{{x}}\nb', { x: 'MIDDLE' }) === 'a\nMIDDLE\nb');

// ── _readTemplate ────────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autohost-tmpl-'));
const tmplPath = path.join(tmpDir, 'vhost-template.conf');
fs.writeFileSync(tmplPath, 'server { name {{hostname}}; }');

check('_readTemplate reads existing file',
    templates._readTemplate(tmplPath) === 'server { name {{hostname}}; }');

check('_readTemplate returns null for missing file',
    templates._readTemplate(path.join(tmpDir, 'does-not-exist.conf')) === null);

check('_readTemplate returns null when path is null',
    templates._readTemplate(null) === null);

check('_readTemplate returns null when path is empty',
    templates._readTemplate('') === null);

// ── render() with file ──────────────────────────────────────────────────────
templates.reloadAll();  // clear cache from any prior tests
const rendered = templates.render('nginx', tmplPath, '<<DEFAULT>>', {
    hostname: 'app.example.com',
});
check('render uses file when present',
    rendered === 'server { name app.example.com; }');

check('render uses default when file missing',
    templates.render('nginx', path.join(tmpDir, 'nope.conf'), '<<DEFAULT>>', {}) === '<<DEFAULT>>');

check('render uses default when path is null',
    templates.render('nginx', null, '<<DEFAULT>>', {}) === '<<DEFAULT>>');

// ── Engine integration: custom template through engine.vhostConfigFor ───────
templates.reloadAll();
const customTemplate = `# CUSTOM for {{hostname}}
server {
    server_name {{hostname}};
    root /var/www/{{hostname}};
    ssl_certificate {{certPath}};
    ssl_certificate_key {{keyPath}};
    location / {
        try_files $uri @backend;
    }
    location @backend {
        proxy_pass http://{{proxyTarget}};
    }
}`;
const customPath = path.join(tmpDir, 'custom.conf');
fs.writeFileSync(customPath, customTemplate);

const nginxEngine = require('../src/engines/nginx').create({
    provider: 'letsencrypt',
    proxyTarget: '10.0.0.1:8080',
    acmeChallengesRoot: '/var/lib/autohost',
    nginxBinary: '/bin/true',
    vhostTemplatePath: customPath,
});
templates.reloadAll();
const out = nginxEngine.vhostConfigFor('shop.example.com', '/c/shop.crt', '/c/shop.key', { proxyTarget: '10.0.0.1:8080' });

check('engine renders custom template with hostname substitution',
    out.includes('# CUSTOM for shop.example.com') &&
    out.includes('server_name shop.example.com'));

check('engine substitutes hostname in multiple positions',
    out.includes('/var/www/shop.example.com'));

check('engine substitutes proxyTarget into custom template',
    out.includes('proxy_pass http://10.0.0.1:8080'));

check('engine substitutes cert paths into custom template',
    out.includes('/c/shop.crt') && out.includes('/c/shop.key'));

check('engine preserves nginx $variables in custom template',
    out.includes('$uri') && out.includes('@backend'));

check('engine prepends auto-provisioned header',
    out.startsWith('# Auto-provisioned by autohost on '));

// ── HSTS opt-in via template ────────────────────────────────────────────────
// Default templates ship without HSTS so HTTP-first onboarding works clean.
// Operators who want HSTS add it to their custom template — this test
// confirms the path works.
templates.reloadAll();
const hstsTemplate = `server {
    listen 443 ssl http2;
    server_name {{hostname}};
    ssl_certificate {{certPath}};
    ssl_certificate_key {{keyPath}};
    add_header Strict-Transport-Security "max-age=31536000" always;
    location / { proxy_pass http://{{proxyTarget}}; }
}`;
const hstsPath = path.join(tmpDir, 'hsts.conf');
fs.writeFileSync(hstsPath, hstsTemplate);

const hstsEngine = require('../src/engines/nginx').create({
    provider: 'letsencrypt',
    proxyTarget: '127.0.0.1:3000',
    acmeChallengesRoot: '/var/lib/autohost',
    nginxBinary: '/bin/true',
    vhostTemplatePath: hstsPath,
});
templates.reloadAll();
const hstsOut = hstsEngine.vhostConfigFor('secure.example.com', '/c/s.crt', '/c/s.key', {});
check('operator can opt into HSTS via custom template',
    hstsOut.includes('Strict-Transport-Security') &&
    hstsOut.includes('max-age=31536000'));

// ── Apache engine with custom template ──────────────────────────────────────
templates.reloadAll();
const apacheTemplate = `<VirtualHost *:443>
    ServerName {{hostname}}
    DocumentRoot /srv/{{hostname}}
    SSLCertificateFile {{certPath}}
    RequestHeader set X-Forwarded-Host "%{HTTP_HOST}s"
    ProxyPass / http://{{proxyTarget}}/
</VirtualHost>`;
const apachePath = path.join(tmpDir, 'apache-custom.conf');
fs.writeFileSync(apachePath, apacheTemplate);

const apacheEngine = require('../src/engines/apache').create({
    provider: 'letsencrypt',
    proxyTarget: '10.0.0.1:8080',
    acmeChallengesRoot: '/var/lib/autohost',
    apacheBinary: '/bin/true',
    vhostTemplatePath: apachePath,
});
templates.reloadAll();
const apOut = apacheEngine.vhostConfigFor('shop.example.com', '/c/s.crt', '/c/s.key', { proxyTarget: '10.0.0.1:8080' });

check('apache engine renders custom template',
    apOut.includes('ServerName shop.example.com') &&
    apOut.includes('/srv/shop.example.com'));

check('apache engine preserves %{VAR} in custom template',
    apOut.includes('%{HTTP_HOST}s'));

// ── Default fallback ────────────────────────────────────────────────────────
templates.reloadAll();
const nginxEngineNoFile = require('../src/engines/nginx').create({
    provider: 'letsencrypt',
    proxyTarget: '127.0.0.1:3000',
    acmeChallengesRoot: '/var/lib/autohost',
    nginxBinary: '/bin/true',
    vhostTemplatePath: '/nonexistent/path/template.conf',
});
const defaultOut = nginxEngineNoFile.vhostConfigFor('fallback.example.com', '/c/f.crt', '/c/f.key', {});
check('engine falls back to built-in default when template file is missing',
    defaultOut.includes('server_name fallback.example.com') &&
    /proxy_pass\s+http:\/\/127\.0\.0\.1:3000/.test(defaultOut));

// ── Cache behavior: edits to template file aren't picked up until reloadAll ─
templates.reloadAll();
fs.writeFileSync(customPath, 'v1: {{hostname}}');
const r1 = templates.render('nginx', customPath, '<<D>>', { hostname: 'a.com' });
fs.writeFileSync(customPath, 'v2: {{hostname}}');
const r2 = templates.render('nginx', customPath, '<<D>>', { hostname: 'a.com' });
check('cache: in-memory template survives file edits until reload',
    r1 === 'v1: a.com' && r2 === 'v1: a.com');

templates.reloadAll();
const r3 = templates.render('nginx', customPath, '<<D>>', { hostname: 'a.com' });
check('cache: reloadAll picks up new content',
    r3 === 'v2: a.com');

// Cleanup
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
