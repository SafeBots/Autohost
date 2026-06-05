// test/testReload.js
//
// Tests the reload logic: nginx -t pre-flight, debounce, mutex, post-reload
// retry. Uses a fake nginx that records its invocations and can simulate
// config-test failures.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autohost-reload-'));
const callLog = path.join(tmpDir, 'calls.log');
const failFlag = path.join(tmpDir, 'fail-t');

// Fake nginx: logs each invocation. If 'fail-t' flag exists and args[0]==='-t',
// exit 1 to simulate config-test failure.
const fakeNginx = path.join(tmpDir, 'fake-nginx.sh');
fs.writeFileSync(fakeNginx, `#!/bin/bash
echo "$(date +%s.%N) $@" >> "${callLog}"
if [[ -f "${failFlag}" && "$1" == "-t" ]]; then exit 1; fi
sleep 0.05
exit 0
`);
fs.chmodSync(fakeNginx, 0o755);

const cfgPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
    provider: 'none',
    socketPath: path.join(tmpDir, 'sock'),
    vhostDir: path.join(tmpDir, 'auto'),
    certDir: path.join(tmpDir, 'auto-certs'),
    acmeChallengesRoot: tmpDir,
    acmeAccountKeyPath: path.join(tmpDir, 'acme.key'),
    nginxBinary: fakeNginx,
    ourIps: ['127.0.0.1'],
    logLevel: 'error',
}));
process.env.AUTOVHOST_CONFIG = cfgPath;
process.env.AUTOVHOST_PROVIDER = 'none';

const av = require('../src/autohost');

function callCount(predicate) {
    try {
        const lines = fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
        if (!predicate) return lines.length;
        return lines.filter(predicate).length;
    } catch { return 0; }
}

(async () => {
    // Test 1: single reload → 2 nginx calls (one -t, one -s reload)
    av._resetReloadState();
    try { fs.unlinkSync(callLog); } catch {}
    av._queueReload();
    await sleep(400);
    const total1 = callCount();
    const tCount1 = callCount(l => l.includes(' -t'));
    const reloadCount1 = callCount(l => l.includes(' -s reload'));
    check('single reload → 1 -t call + 1 reload call',
        tCount1 === 1 && reloadCount1 === 1,
        `total=${total1} -t=${tCount1} reload=${reloadCount1}`);

    // Test 2: nginx -t failure → no reload
    av._resetReloadState();
    try { fs.unlinkSync(callLog); } catch {}
    fs.writeFileSync(failFlag, '1');
    av._queueReload();
    await sleep(400);
    const tCount2 = callCount(l => l.includes(' -t'));
    const reloadCount2 = callCount(l => l.includes(' -s reload'));
    check('nginx -t failure → -t called but no reload',
        tCount2 === 1 && reloadCount2 === 0);
    fs.unlinkSync(failFlag);

    // Test 3: burst debounced
    av._resetReloadState();
    try { fs.unlinkSync(callLog); } catch {}
    for (let i = 0; i < 10; i++) av._queueReload();
    await sleep(2800);
    const tCount3 = callCount(l => l.includes(' -t'));
    check('10 rapid queueReloads → <=2 -t calls',
        tCount3 >= 1 && tCount3 <= 2,
        `-t count=${tCount3}`);

    // Test 4: reload during in-flight triggers second reload after debounce
    av._resetReloadState();
    try { fs.unlinkSync(callLog); } catch {}
    av._queueReload();
    await sleep(50);  // first -t + reload still running (50ms sleep each in fake nginx)
    av._queueReload();
    await sleep(3000);
    const tCount4 = callCount(l => l.includes(' -t'));
    check('reload during in-flight triggers second reload',
        tCount4 === 2,
        `-t count=${tCount4}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
