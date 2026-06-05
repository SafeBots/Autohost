// test/testEngines.js
//
// Tests both web server engines. nginx + Apache both export the same
// interface (vhostConfigFor, validateConfig, reload, vhostFileExtension);
// these tests exercise each one with the same inputs and verify they
// produce engine-appropriate output.

'use strict';

process.env.AUTOVHOST_PROVIDER = 'none';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

const baseCfg = {
    provider: 'letsencrypt',
    proxyTarget: '127.0.0.1:3000',
    acmeChallengesRoot: '/var/lib/autohost',
    nginxBinary: '/bin/true',  // fake — won't actually run nginx
    apacheBinary: '/bin/true',
};

// ── nginx engine ─────────────────────────────────────────────────────────────
const nginx = require('../src/engines/nginx').create(baseCfg);

check('nginx engine has name', nginx.name === 'nginx');
check('nginx engine has .conf extension', nginx.vhostFileExtension === '.conf');

const ngVhost = nginx.vhostConfigFor('test.example.com', '/c/test.crt', '/c/test.key', { hsts: true });
check('nginx vhost is nginx syntax', ngVhost.includes('server {') && ngVhost.includes('server_name'));
check('nginx vhost listens on 443 ssl http2', ngVhost.includes('listen 443 ssl http2'));
check('nginx vhost listens on 80', ngVhost.includes('listen 80;'));
check('nginx vhost includes proxy_pass', ngVhost.includes('proxy_pass'));
check('nginx vhost has security headers', ngVhost.includes('X-Content-Type-Options') && ngVhost.includes('X-Frame-Options'));
// (HSTS now template-controlled — tested in testTemplates.js)

// ── apache engine ────────────────────────────────────────────────────────────
const apache = require('../src/engines/apache').create(baseCfg);

check('apache engine has name', apache.name === 'apache');
check('apache engine has .conf extension', apache.vhostFileExtension === '.conf');

const apVhost = apache.vhostConfigFor('test.example.com', '/c/test.crt', '/c/test.key', { hsts: true });
check('apache vhost is Apache syntax', apVhost.includes('<VirtualHost') && apVhost.includes('ServerName'));
check('apache vhost has SSLEngine on', apVhost.includes('SSLEngine on'));
check('apache vhost has SSLCertificateFile', apVhost.includes('SSLCertificateFile'));
check('apache vhost has SSLCertificateKeyFile', apVhost.includes('SSLCertificateKeyFile'));
check('apache vhost has ProxyPass', apVhost.includes('ProxyPass'));
check('apache vhost has security headers', apVhost.includes('X-Content-Type-Options') && apVhost.includes('X-Frame-Options'));
check('apache vhost has port 443', apVhost.includes('VirtualHost *:443'));
check('apache vhost has port 80', apVhost.includes('VirtualHost *:80'));
check('apache vhost has HTTP→HTTPS redirect', apVhost.includes('RewriteRule') && apVhost.includes('https://'));
// (HSTS now template-controlled — tested in testTemplates.js)

// ── Both engines accept the same hostname format and produce valid output ────
const hostnames = ['app.example.com', 'a-b-c.example.com', 'sub.deep.zone.example.com'];
for (const h of hostnames) {
    const ng = nginx.vhostConfigFor(h, '/c/x.crt', '/c/x.key', { hsts: true });
    const ap = apache.vhostConfigFor(h, '/c/x.crt', '/c/x.key', { hsts: true });
    check(`nginx accepts ${h}`, ng.includes(h));
    check(`apache accepts ${h}`, ap.includes(h));
}

// ── validateConfig + reload return promise structure ─────────────────────────
async function checkAsync() {
    // /bin/true returns 0 for any args, so this just verifies the shape
    const v = await nginx.validateConfig();
    check('nginx validateConfig returns {ok, stderr}',
        typeof v.ok === 'boolean' && typeof v.stderr === 'string');

    const r = await nginx.reload();
    check('nginx reload returns {ok, stderr}',
        typeof r.ok === 'boolean' && typeof r.stderr === 'string');

    const va = await apache.validateConfig();
    check('apache validateConfig returns {ok, stderr}',
        typeof va.ok === 'boolean' && typeof va.stderr === 'string');

    const ra = await apache.reload();
    check('apache reload returns {ok, stderr}',
        typeof ra.ok === 'boolean' && typeof ra.stderr === 'string');

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
}

checkAsync().catch((e) => { console.error(e); process.exit(2); });
