// test/testProviders.js
//
// Tests for the cert providers. Tests the 'none' provider end-to-end
// (it generates real self-signed certs) and the Cloudflare provider's
// CSR generation (without actually calling Cloudflare).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.AUTOVHOST_PROVIDER = 'none';

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function main() {
    // ── 'none' provider: produces a real self-signed cert ────────────────────
    const noneProvider = require('../src/providers/none').create({});
    const { cert, key } = await noneProvider.provisionCert('test.example.com');
    check('none provider returns cert PEM',
        cert.includes('BEGIN CERTIFICATE'));
    check('none provider returns key PEM',
        key.includes('BEGIN') && key.includes('PRIVATE KEY'));

    // Parse the cert and verify CN
    try {
        const x509 = new crypto.X509Certificate(cert);
        check('none provider cert has correct CN',
            x509.subject.includes('test.example.com'));
        check('none provider cert is currently valid',
            new Date(x509.validFrom) <= new Date() &&
            new Date(x509.validTo) > new Date());
    } catch (e) {
        check('parse self-signed cert', false, e.message);
    }

    // ── Cloudflare provider: CSR generation (offline) ────────────────────────
    process.env.AUTOVHOST_CLOUDFLARE_API_TOKEN = 'fake-token-for-test';
    const cloudflare = require('../src/providers/cloudflare');
    const { csrPem, keyPem } = await cloudflare._generateCsr('cf-test.example.com');
    check('cloudflare CSR is PEM',
        csrPem.includes('BEGIN CERTIFICATE REQUEST') &&
        csrPem.includes('END CERTIFICATE REQUEST'));
    check('cloudflare CSR has key',
        keyPem.includes('BEGIN') && keyPem.includes('PRIVATE KEY'));

    // The CSR should contain the hostname (we can't easily decode the binary,
    // but node-forge would parse it; cheap check: it shouldn't be empty)
    check('cloudflare CSR is non-trivially long',
        csrPem.length > 300);

    // ── Loading providers by name ────────────────────────────────────────────
    const cf = require('../src/providers/cloudflare').create({});
    check('cloudflare provider has name', cf.name === 'cloudflare');
    check('cloudflare provider exposes provisionCert', typeof cf.provisionCert === 'function');
    check('cloudflare provider exposes renewCert', typeof cf.renewCert === 'function');

    // Cleanup
    delete process.env.AUTOVHOST_CLOUDFLARE_API_TOKEN;

    // ── Cloudflare provider requires API token ──────────────────────────────
    let threw = false;
    try {
        require('../src/providers/cloudflare').create({});
    } catch (e) {
        threw = e.message.includes('AUTOVHOST_CLOUDFLARE_API_TOKEN');
    }
    check('cloudflare provider rejects missing token',
        threw);

    // ── CloudFront provider requires env vars ───────────────────────────────
    delete process.env.AUTOVHOST_AWS_REGION;
    delete process.env.AUTOVHOST_CLOUDFRONT_DISTRIBUTION_ID;
    let cfThrew = false;
    try {
        require('../src/providers/cloudfront').create({});
    } catch (e) {
        cfThrew = e.message.includes('AUTOVHOST_AWS_REGION');
    }
    check('cloudfront provider rejects missing env',
        cfThrew);

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
