// src/providers/none.js
//
// Self-signed cert provider. Useful for testing autohost without burning
// Let's Encrypt rate limits, or when running behind a CDN that doesn't
// verify origin certs. Not for production-facing TLS — browsers will warn.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function create(cfg) {
    async function provisionCert(host) {
        // Use openssl. Generates a 2048-bit RSA key and a self-signed cert
        // valid for 365 days with the host as CN and SAN.
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autohost-none-'));
        const keyPath = path.join(tmpDir, 'key.pem');
        const certPath = path.join(tmpDir, 'cert.pem');
        try {
            execFileSync('openssl', [
                'req', '-x509', '-newkey', 'rsa:2048',
                '-keyout', keyPath,
                '-out', certPath,
                '-days', '365',
                '-nodes',
                '-subj', `/CN=${host}`,
                '-addext', `subjectAltName=DNS:${host}`,
            ], { stdio: ['ignore', 'ignore', 'pipe'] });

            const cert = fs.readFileSync(certPath, 'utf8');
            const key  = fs.readFileSync(keyPath, 'utf8');
            return { cert, key };
        } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        }
    }

    return {
        name: 'none',
        provisionCert,
        renewCert: provisionCert,
    };
}

module.exports = { create };
