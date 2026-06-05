// test/testCdnMode.js
//
// Verifies the CDN-mode behavior: when provider is 'cloudflare' or
// 'cloudfront', the DNS pre-check is skipped because the CDN already
// validated the hostname on its side. This makes provisioning fast and
// avoids unnecessary external DNS lookups.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function main() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autohost-cdn-'));
    const cfgPath = path.join(tmpDir, 'config.json');

    // ── Test 1: letsencrypt → NOT CDN mode ──────────────────────────────────
    fs.writeFileSync(cfgPath, JSON.stringify({
        provider: 'letsencrypt',
        socketPath: path.join(tmpDir, 'sock'),
        vhostDir: path.join(tmpDir, 'auto'),
        certDir: path.join(tmpDir, 'auto-certs'),
        acmeChallengesRoot: tmpDir,
        acmeAccountKeyPath: path.join(tmpDir, 'acme.key'),
        nginxBinary: '/bin/true',
        ourIps: ['127.0.0.1'],
        logLevel: 'error',
    }));
    process.env.AUTOVHOST_CONFIG = cfgPath;
    process.env.AUTOVHOST_PROVIDER = 'letsencrypt';

    // Clear require cache so we get a fresh config
    delete require.cache[require.resolve('../src/autohost')];
    delete require.cache[require.resolve('../src/config')];

    const av1 = require('../src/autohost');
    check('letsencrypt provider → isCdnMode === false', av1._isCdnMode === false);

    // ── Test 2: cloudflare → CDN mode ───────────────────────────────────────
    fs.writeFileSync(cfgPath, JSON.stringify({
        provider: 'cloudflare',
        socketPath: path.join(tmpDir, 'sock2'),
        vhostDir: path.join(tmpDir, 'auto2'),
        certDir: path.join(tmpDir, 'auto-certs2'),
        acmeChallengesRoot: tmpDir,
        acmeAccountKeyPath: path.join(tmpDir, 'acme.key'),
        nginxBinary: '/bin/true',
        ourIps: ['127.0.0.1'],
        logLevel: 'error',
    }));
    process.env.AUTOVHOST_PROVIDER = 'cloudflare';
    process.env.AUTOVHOST_CLOUDFLARE_API_TOKEN = 'fake-token';

    // Clear caches
    delete require.cache[require.resolve('../src/autohost')];
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/providers/cloudflare')];

    const av2 = require('../src/autohost');
    check('cloudflare provider → isCdnMode === true', av2._isCdnMode === true);
    check('cloudflare provider has correct name', av2._provider.name === 'cloudflare');

    // ── Test 3: cloudfront → CDN mode ───────────────────────────────────────
    process.env.AUTOVHOST_AWS_REGION = 'us-east-1';
    process.env.AUTOVHOST_CLOUDFRONT_DISTRIBUTION_ID = 'E1234567';

    fs.writeFileSync(cfgPath, JSON.stringify({
        provider: 'cloudfront',
        socketPath: path.join(tmpDir, 'sock3'),
        vhostDir: path.join(tmpDir, 'auto3'),
        certDir: path.join(tmpDir, 'auto-certs3'),
        acmeChallengesRoot: tmpDir,
        acmeAccountKeyPath: path.join(tmpDir, 'acme.key'),
        nginxBinary: '/bin/true',
        ourIps: ['127.0.0.1'],
        logLevel: 'error',
    }));
    process.env.AUTOVHOST_PROVIDER = 'cloudfront';

    delete require.cache[require.resolve('../src/autohost')];
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/providers/cloudfront')];

    const av3 = require('../src/autohost');
    check('cloudfront provider → isCdnMode === true', av3._isCdnMode === true);

    // Cleanup
    delete process.env.AUTOVHOST_CLOUDFLARE_API_TOKEN;
    delete process.env.AUTOVHOST_AWS_REGION;
    delete process.env.AUTOVHOST_CLOUDFRONT_DISTRIBUTION_ID;
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
