// test/testHandler.js
//
// Tests the HTTP handler that nginx posts to. We start the socket server
// in-process, make POSTs to it, and verify responses. The provisioning
// logic is stubbed so we don't burn real ACME quotas.

'use strict';

process.env.AUTOVHOST_PROVIDER = 'none';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autohost-handler-'));
const socketPath = path.join(tmpDir, 'autohost.sock');
const cfgPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
    provider: 'none',
    socketPath,
    vhostDir: path.join(tmpDir, 'auto'),
    certDir: path.join(tmpDir, 'auto-certs'),
    acmeChallengesRoot: path.join(tmpDir, 'autohost'),
    acmeAccountKeyPath: path.join(tmpDir, 'acme-account.key'),
    nginxBinary: '/bin/true',
    ourIps: ['127.0.0.1'],
    logLevel: 'error',  // suppress info logs during tests
}));
process.env.AUTOVHOST_CONFIG = cfgPath;

const av = require('../src/autohost');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Stub provision to return synthetic outcomes
let stubResponse = { status: 'ok', code: 'STUB_OK' };
let provisionedHosts = [];
const originalProvision = av.provision;
av.provision = async function(host, requestIp) {
    provisionedHosts.push({ host, requestIp });
    if (!av._isValidHostname(host)) {
        return { status: 'error', code: 'INVALID_HOST' };
    }
    return stubResponse;
};

function post(socketPath, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = typeof body === 'string' ? body : JSON.stringify(body);
        const req = http.request({
            method: 'POST',
            socketPath,
            path: urlPath,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
            },
            timeout: 3000,
        }, (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
    });
}

(async () => {
    const server = av.startServer();
    let waited = 0;
    while (!fs.existsSync(socketPath) && waited < 2000) {
        await sleep(50); waited += 50;
    }
    check('socket bound', fs.existsSync(socketPath));

    // Wrong path
    const r1 = await post(socketPath, '/something-else', { host: 'app.example.com' });
    check('wrong path → 404', r1.status === 404);

    // Valid host
    stubResponse = { status: 'ok', code: 'INSTALLED' };
    provisionedHosts = [];
    const r2 = await post(socketPath, '/provision', { host: 'app.example.com', requestIp: '203.0.113.5' });
    check('valid host → 200', r2.status === 200);
    check('valid host → status:ok', JSON.parse(r2.body).status === 'ok');
    check('provision called with host', provisionedHosts.length === 1 && provisionedHosts[0].host === 'app.example.com');
    check('provision called with requestIp', provisionedHosts[0].requestIp === '203.0.113.5');

    // Invalid host
    const r3 = await post(socketPath, '/provision', { host: 'has space.example.com' });
    check('invalid host → status:error', JSON.parse(r3.body).status === 'error');

    // Malformed JSON
    const r4 = await post(socketPath, '/provision', '{not json}');
    check('malformed JSON → 400', r4.status === 400);

    // Error pass-through
    stubResponse = { status: 'error', code: 'ACME_FAILED', message: 'rate limit' };
    const r5 = await post(socketPath, '/provision', { host: 'fail.example.com' });
    check('provider error passed through',
        r5.status === 200 && JSON.parse(r5.body).code === 'ACME_FAILED');

    // Missing host
    const r6 = await post(socketPath, '/provision', {});
    check('missing host → error', JSON.parse(r6.body).status === 'error');

    // Cleanup
    av.provision = originalProvision;
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
