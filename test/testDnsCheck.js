// test/testDnsCheck.js
//
// Tests the multi-resolver DNS check. We can't easily mock DNS without
// patching dns.promises, so we test the partial-failure behavior with a
// known-good host and a known-bad resolver.

'use strict';

process.env.AUTOVHOST_PROVIDER = 'none';

const dc = require('../src/dnsCheck');

let pass = 0, fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; console.log('PASS', name); }
    else { fail++; console.log('FAIL', name, detail || ''); }
}

async function main() {
    // ── Single bad resolver (unreachable IP) returns error tag ──────────────
    // Use 192.0.2.0 (TEST-NET-1) which is RFC-reserved as unreachable.
    let bad;
    try {
        await dc._resolveOne('example.com', '192.0.2.0');
        bad = null;
    } catch (e) {
        bad = e.message;
    }
    check('unreachable resolver throws error',
        bad !== null,
        `result was: ${bad === null ? 'resolved (unexpected)' : 'error: ' + bad}`);

    // ── Multi-resolver query with all-failing resolvers returns 0 ips ───────
    const allBad = await dc.resolveAcrossResolvers('nonexistent-zzz-test.invalid', ['203.0.113.99']);
    check('all-failing resolvers → ips.length === 0',
        Array.isArray(allBad.ips) && allBad.ips.length === 0);
    check('all-failing resolvers → errors collected',
        allBad.errors.length > 0);

    // ── Mixed: one bad + one might-be-good (system) ─────────────────────────
    // Since we don't know what 'example.com' resolves to in this env, just
    // verify the structure of the response.
    const mixed = await dc.resolveAcrossResolvers('example.com', ['system', '203.0.113.99']);
    check('mixed resolvers returns ips array',
        Array.isArray(mixed.ips));
    check('mixed resolvers returns errors array',
        Array.isArray(mixed.errors));
    check('at least one resolver responded (either ok or error)',
        mixed.ips.length + mixed.errors.length >= 1);

    console.log('');
    console.log(`${pass}/${pass + fail} passed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
