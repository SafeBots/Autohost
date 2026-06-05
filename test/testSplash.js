// test/testSplash.js
//
// Verifies the two static splash HTML files have the right shape:
//   - splash.html       — HTTP-first design surface; full UX, refresh meta
//   - splash-https.html — minimal HTTPS-fallback message
// Both must be self-contained (no external scripts, stylesheets, or images)
// so they load reliably without any cert chain the browser trusts and
// without any extra DNS lookups.

'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

// ── splash.html (HTTP-first design surface) ─────────────────────────────────
const splashPath = path.resolve(__dirname, '..', 'src', 'static', 'splash.html');
const html = fs.readFileSync(splashPath, 'utf8');

check('splash.html exists and is substantial', html.length > 1500);
check('splash.html has doctype', html.toLowerCase().startsWith('<!doctype html>'));
check('splash.html has Safebox brand', html.includes('Safebox'));
check('splash.html has provisioning message',
    /provisioning|setting up|issuing/i.test(html));
check('splash.html has refresh meta', html.includes('http-equiv="refresh"'));
check('splash.html has noindex robots', html.includes('noindex'));
check('splash.html includes DNS troubleshooting hint', /\bDNS\b/.test(html));
check('splash.html mentions Let\'s Encrypt or TLS certificate',
    /Let's Encrypt|TLS certificate|certificate/i.test(html));

// Self-containment
check('splash.html has no external <script src=>',
    !/<script[^>]+src=/i.test(html));
check('splash.html has no external stylesheet',
    !/<link[^>]+stylesheet[^>]+href=["']http/i.test(html));
check('splash.html has no external <img>',
    !/<img[^>]+src=["']http/i.test(html));
check('splash.html has no @import url(http',
    !/@import\s+url\(["']?http/i.test(html));

// ── splash-https.html (minimal HTTPS-fallback) ──────────────────────────────
const httpsSplashPath = path.resolve(__dirname, '..', 'src', 'static', 'splash-https.html');
const httpsHtml = fs.readFileSync(httpsSplashPath, 'utf8');

check('splash-https.html exists', httpsHtml.length > 200);
check('splash-https.html has doctype', httpsHtml.toLowerCase().startsWith('<!doctype html>'));
check('splash-https.html explains the situation',
    /HTTPS|certificate|warning/i.test(httpsHtml));
check('splash-https.html points user to HTTP',
    /HTTP|plain HTTP|http:\/\//i.test(httpsHtml));
check('splash-https.html is self-contained — no external scripts',
    !/<script[^>]+src=/i.test(httpsHtml));
check('splash-https.html is self-contained — no external stylesheets',
    !/<link[^>]+stylesheet[^>]+href=["']http/i.test(httpsHtml));

console.log('');
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
