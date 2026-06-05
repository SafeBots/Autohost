// test/testUnit.js
//
// Unit tests for pure functions. Fast and deterministic.

'use strict';

process.env.AUTOVHOST_PROVIDER = 'none';

const av = require('../src/autohost');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// Hostname validation
check('valid simple domain', av._isValidHostname('example.com'));
check('valid sub-domain', av._isValidHostname('app.example.com'));
check('valid deep sub-domain', av._isValidHostname('a.b.c.example.com'));
check('valid with hyphens', av._isValidHostname('my-app.example.com'));
check('valid with digits', av._isValidHostname('app123.example.com'));

check('reject empty', !av._isValidHostname(''));
check('reject single label', !av._isValidHostname('example'));
check('reject leading hyphen', !av._isValidHostname('-app.example.com'));
check('reject trailing hyphen', !av._isValidHostname('app-.example.com'));
check('reject leading dot', !av._isValidHostname('.example.com'));
check('reject trailing dot', !av._isValidHostname('example.com.'));
check('reject double dot', !av._isValidHostname('app..example.com'));
check('reject underscore', !av._isValidHostname('my_app.example.com'));
check('reject space', !av._isValidHostname('app .example.com'));
check('reject special char', !av._isValidHostname('app$.example.com'));
check('reject path injection', !av._isValidHostname('example.com/foo'));
check('reject newline', !av._isValidHostname('example.com\n'));
check('reject null byte', !av._isValidHostname('example.com\x00'));
check('reject label > 63 chars', !av._isValidHostname('a'.repeat(64) + '.example.com'));
check('reject host > 253 chars', !av._isValidHostname(('a'.repeat(60) + '.').repeat(5) + 'com'));
check('reject non-string null', !av._isValidHostname(null));
check('reject non-string number', !av._isValidHostname(123));
check('reject non-string object', !av._isValidHostname({}));

// Vhost generation — via engine
const v = av._engine.vhostConfigFor('app.example.com', '/certs/app.example.com.crt', '/certs/app.example.com.key', { proxyTarget: '127.0.0.1:3000' });
check('vhost has server_name', v.includes('server_name app.example.com;'));
check('vhost has TLS 1.2/1.3', v.includes('TLSv1.2 TLSv1.3'));
check('default vhost does NOT set HSTS', !v.includes('Strict-Transport-Security'));
check('vhost has HTTP→HTTPS redirect', v.includes('return 301 https://'));
check('vhost has ACME location for renewals', v.includes('/.well-known/acme-challenge/'));
check('vhost has proxy_pass', v.includes('proxy_pass'));
check('vhost has proxy headers', v.includes('X-Forwarded-For') && v.includes('X-Forwarded-Proto'));
check('vhost has no shell metachars from host', !v.includes('$(') && !v.includes('`'));

// HSTS is opt-in via template override: default templates ship without HSTS
// so the clean HTTP-first onboarding flow works. Operators who want HSTS
// add it to their /etc/autohost/vhost-template.conf. We test the template
// override path in testTemplates.js.

// Apache engine
const apacheEngine = require('../src/engines/apache').create({
    provider: 'letsencrypt',
    proxyTarget: '127.0.0.1:3000',
    acmeChallengesRoot: '/var/lib/autohost',
});
const va = apacheEngine.vhostConfigFor('app.example.com', '/c/x.crt', '/c/x.key', {});
check('apache vhost has ServerName', va.includes('ServerName app.example.com'));
check('apache vhost has SSLCertificateFile', va.includes('SSLCertificateFile'));
check('apache vhost has ProxyPass', va.includes('ProxyPass'));
check('default apache vhost does NOT set HSTS', !va.includes('Strict-Transport-Security'));

// DNS check module exists
const dc = require('../src/dnsCheck');
check('dnsCheck exports resolveAcrossResolvers', typeof dc.resolveAcrossResolvers === 'function');

// Logger
const logger = require('../src/logger');
const log = logger.create('test', 'info');
check('logger creates with all levels',
    typeof log.error === 'function' &&
    typeof log.warn === 'function' &&
    typeof log.info === 'function' &&
    typeof log.debug === 'function');

// Rate limit
const rl = require('../src/rateLimit');
rl._reset();
check('per-IP rate limit allows first call', rl.allowPerIp('1.2.3.4'));
check('global rate limit allows first call', rl.allowGlobal());

// Exhaust rate limit
rl._reset();
let allowed = 0;
for (let i = 0; i < 50; i++) {
    if (rl.allowPerIp('5.6.7.8')) allowed++;
}
check('per-IP rate limit caps at limit', allowed === 10);  // default 10/hour

rl._reset();
allowed = 0;
for (let i = 0; i < 200; i++) {
    if (rl.allowGlobal()) allowed++;
}
check('global rate limit caps at limit', allowed === 100);  // default 100/hour

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
