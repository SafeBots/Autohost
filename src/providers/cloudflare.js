// src/providers/cloudflare.js
//
// Cloudflare Origin CA cert provider. The user configures their domain on
// Cloudflare with proxying ENABLED (orange cloud). Cloudflare terminates
// browser TLS with their managed cert. We just need an "Origin CA" cert
// — a Cloudflare-issued cert that ONLY Cloudflare trusts, for the
// Cloudflare→origin leg. These are free, valid up to 15 years, issued
// instantly via API. No ACME, no rate limits, no DNS validation.
//
// Required env vars:
//   AUTOVHOST_CLOUDFLARE_API_TOKEN — token with "Origin CA" issuance scope
//
// Optional:
//   AUTOVHOST_CLOUDFLARE_CERT_VALIDITY_DAYS — defaults to 5475 (15 years)
//
// Cloudflare API doc: https://developers.cloudflare.com/api/operations/origin-ca-create-certificate

'use strict';

const https = require('https');
const crypto = require('crypto');

function httpsRequest(opts, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(opts, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(buf); } catch { parsed = buf; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Generate a CSR using Node's built-in crypto (no external deps).
// Returns { csrPem, keyPem }.
async function generateCsr(host) {
    const { generateKeyPairSync, createPrivateKey } = require('crypto');
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });

    // Node 19+ has X509Certificate but not CSR generation. We use a minimal
    // ASN.1-by-hand approach. For broader compatibility we instead require
    // the `node-forge` package, which is a small pure-JS crypto lib.
    const forge = require('node-forge');
    const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });

    const forgeKey = forge.pki.privateKeyFromPem(keyPem);
    const forgePub = forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e);

    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = forgePub;
    csr.setSubject([{ name: 'commonName', value: host }]);
    csr.setAttributes([{
        name: 'extensionRequest',
        extensions: [{
            name: 'subjectAltName',
            altNames: [{ type: 2, value: host }],  // type 2 = DNS
        }],
    }]);
    csr.sign(forgeKey, forge.md.sha256.create());
    const csrPem = forge.pki.certificationRequestToPem(csr);

    return { csrPem, keyPem };
}

function create(cfg) {
    const apiToken = process.env.AUTOVHOST_CLOUDFLARE_API_TOKEN;
    if (!apiToken) {
        throw new Error('cloudflare provider requires AUTOVHOST_CLOUDFLARE_API_TOKEN env var');
    }
    const validityDays = parseInt(process.env.AUTOVHOST_CLOUDFLARE_CERT_VALIDITY_DAYS || '5475', 10);

    async function provisionCert(host) {
        const { csrPem, keyPem } = await generateCsr(host);

        const body = JSON.stringify({
            hostnames: [host],
            request_type: 'origin-rsa',
            requested_validity: validityDays,
            csr: csrPem,
        });

        const result = await httpsRequest({
            method: 'POST',
            host: 'api.cloudflare.com',
            path: '/client/v4/certificates',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, body);

        if (result.status !== 200 || !result.body || !result.body.success) {
            const err = new Error(`cloudflare origin cert issuance failed: ${JSON.stringify((result.body && result.body.errors) || result.body).slice(0, 256)}`);
            err.code = 'CLOUDFLARE_API_ERROR';
            throw err;
        }

        return {
            cert: result.body.result.certificate,
            key:  keyPem,
        };
    }

    return {
        name: 'cloudflare',
        provisionCert,
        renewCert: provisionCert,
    };
}

module.exports = { create, _generateCsr: generateCsr };
