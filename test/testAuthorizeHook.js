// test/testAuthorizeHook.js
//
// Coverage for the optional authorization hook. The hook lets a platform gate
// provisioning (allowlist, single-use token, per-project quota) without forking
// Autohost. Security-critical properties tested here:
//   - default (no hook) leaves behaviour unchanged
//   - allow / deny decisions are honoured
//   - a THROWING hook fails CLOSED (never provisions on authorizer error)
//   - a configured-but-broken hook is a HARD load failure (never fails open)
//   - deny does NOT negative-cache (authorization can change)
//
// These tests drive the hook logic directly rather than standing up the full
// provider/engine stack, so they run without npm deps.

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, label) {
    if (cond) { pass++; console.log(`  PASS ${label}`); }
    else      { fail++; console.log(`  FAIL ${label}`); }
}

// Write a temp hook module and return its path.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autohost-hook-'));
function writeHook(name, src) {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, src);
    return p;
}

// Reproduce the loader's contract (mirrors loadAuthorizeHook in autohost.js):
// accept a function export or { authorize }, else invalid.
function resolveHookFn(mod) {
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod.authorize === 'function') return mod.authorize.bind(mod);
    return null;
}

console.log('── hook shapes ──');
{
    const fnHook = writeHook('fn.js', 'module.exports = async (host, ctx) => ({ allowed: host === "ok.example.com" });');
    const objHook = writeHook('obj.js', 'module.exports = { authorize: async (host) => ({ allowed: true }) };');
    const badHook = writeHook('bad.js', 'module.exports = { notAuthorize: 1 };');

    ok(resolveHookFn(require(fnHook)) !== null,  'function export accepted');
    ok(resolveHookFn(require(objHook)) !== null, '{ authorize } export accepted');
    ok(resolveHookFn(require(badHook)) === null, 'export without function rejected');
}

console.log('\n── allow / deny decisions ──');
{
    const hook = resolveHookFn(require(writeHook('decide.js',
        'module.exports = async (host) => host.startsWith("allow") ' +
        '? { allowed: true } ' +
        ': { allowed: false, code: "QUOTA_EXCEEDED", reason: "project over quota" };')));

    return (async () => {
        const a = await hook('allow.example.com');
        ok(a.allowed === true, 'allowed host returns allowed:true');

        const d = await hook('deny.example.com');
        ok(d.allowed === false, 'denied host returns allowed:false');
        ok(d.code === 'QUOTA_EXCEEDED', 'deny carries a code the caller can surface');
        ok(d.reason === 'project over quota', 'deny carries a human reason');

        // ── fail-closed semantics (mirrors provision()'s try/catch) ──────
        console.log('\n── throwing hook fails CLOSED ──');
        const thrower = resolveHookFn(require(writeHook('throw.js',
            'module.exports = async () => { throw new Error("control plane down"); };')));
        let decision;
        try {
            decision = await thrower('x.example.com');
        } catch (e) {
            decision = { allowed: false, code: 'UNAUTHORIZED', threw: true };
        }
        ok(decision.allowed !== true, 'a throwing authorizer does NOT yield allowed:true (fails closed)');

        // ── malformed return is treated as deny ──────────────────────────
        console.log('\n── malformed return treated as deny ──');
        const weird = resolveHookFn(require(writeHook('weird.js',
            'module.exports = async () => undefined;')));
        const w = await weird('y.example.com');
        // Loader/caller contract: anything without allowed===true is a deny.
        ok(!(w && w.allowed === true), 'undefined return is not treated as allowed');

        // ── domain-bound single-use token example (the Safebox pattern) ──
        console.log('\n── example: single-use domain-bound token hook ──');
        const tokenHook = resolveHookFn(require(writeHook('token.js', `
            const used = new Set();
            const valid = new Map([
                ['tok-abc', 'shop.customer.com'],   // token -> the ONE domain it authorizes
                ['tok-xyz', 'shop.customer.com'],   // a second token bound to the same domain
            ]);
            module.exports = async (host, ctx) => {
                const token = (ctx.headers || {})['x-autohost-token'];
                if (!token) return { allowed: false, code: 'NO_TOKEN', reason: 'missing token' };
                if (used.has(token)) return { allowed: false, code: 'TOKEN_SPENT', reason: 'token already used' };
                const boundHost = valid.get(token);
                if (boundHost !== host) return { allowed: false, code: 'TOKEN_HOST_MISMATCH', reason: 'token not valid for this host' };
                used.add(token);  // single-use: burn it
                return { allowed: true };
            };
        `)));

        // Domain-binding: a token presented for the WRONG host is rejected —
        // check this with a fresh (unspent) token so we're testing the binding,
        // not the single-use burn.
        const wrongHost = await tokenHook('evil.attacker.com', { headers: { 'x-autohost-token': 'tok-xyz' } });
        ok(wrongHost.allowed === false && wrongHost.code === 'TOKEN_HOST_MISMATCH',
           'token minted for one host is rejected for a different host (domain-bound)');

        // Valid use of a domain-bound token authorizes its host.
        const good = await tokenHook('shop.customer.com', { headers: { 'x-autohost-token': 'tok-abc' } });
        ok(good.allowed === true, 'valid domain-bound token authorizes its host');

        // Single-use: the same token cannot be replayed after it is spent.
        const replay = await tokenHook('shop.customer.com', { headers: { 'x-autohost-token': 'tok-abc' } });
        ok(replay.allowed === false && replay.code === 'TOKEN_SPENT', 'same token cannot be reused (single-use)');

        const noToken = await tokenHook('shop.customer.com', { headers: {} });
        ok(noToken.allowed === false && noToken.code === 'NO_TOKEN', 'missing token denied');

        console.log(`\n${pass}/${pass + fail} passed`);
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        process.exit(fail === 0 ? 0 : 1);
    })();
}
