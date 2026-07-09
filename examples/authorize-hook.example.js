// examples/authorize-hook.example.js
//
// Example authorization hook for Autohost. Point `authorizeHook` at a copy of
// this file (or your own) to gate provisioning beyond the built-in DNS check.
//
//   config.json:  { "authorizeHook": "/etc/autohost/authorize-hook.js" }
//   or env:       AUTOVHOST_AUTHORIZE_HOOK=/etc/autohost/authorize-hook.js
//
// The hook is called AFTER DNS/CDN proves the host points at this box and AFTER
// the rate limit, but BEFORE any cert is provisioned — so it gates the
// expensive ACME work. It must export either a function or { authorize }, with:
//
//     async authorize(host, context) -> { allowed: boolean, reason?, code?, meta? }
//
//       host    : requested hostname (already format-validated)
//       context : { requestIp, headers, provider, isCdnMode }
//
// Contract / safety notes:
//   - Anything other than { allowed: true } is treated as a DENY.
//   - A hook that THROWS fails CLOSED (the request is denied), so a control-
//     plane outage never accidentally opens provisioning to everyone.
//   - A denied host is NOT negative-cached by Autohost — authorization can
//     change (quota frees up, a token is minted) without the host being "bad".
//
// This example shows two common patterns. Use whichever fits; delete the other.

'use strict';

// ── Pattern A: static allowlist ────────────────────────────────────────────
// Simplest possible gate. Only hosts you've explicitly declared may provision.
// A multi-tenant platform typically generates this from its own database (which
// project owns which domain) rather than hard-coding it.
const ALLOWLIST = new Set([
    // 'id.customer.com',
    // 'chat.customer.com',
]);

// ── Pattern B: single-use, domain-bound token ──────────────────────────────
// The platform mints a token bound to ONE host, with a short expiry, and hands
// it to the client to send on the first request (as a header — never a query
// string, which leaks into access logs). The token is spent on first use.
//
// In a real deployment `TOKENS` would be a shared store (Redis, a DB table)
// so tokens survive restarts and are visible across processes. Here it's an
// in-memory Map for illustration.
const TOKENS = new Map(); // token -> { host, expiresAt }
const SPENT  = new Set();

// Example: platform calls this when it issues a token to a project.
function mintToken(token, host, ttlMs = 10 * 60 * 1000) {
    TOKENS.set(token, { host, expiresAt: Date.now() + ttlMs });
}

async function authorize(host, context) {
    // Pattern A: allowlist short-circuit.
    if (ALLOWLIST.has(host)) return { allowed: true };

    // Pattern B: token check.
    const headers = context.headers || {};
    const token = headers['x-autohost-token'] || headers['X-Autohost-Token'];
    if (!token) {
        return { allowed: false, code: 'NO_TOKEN', reason: 'no authorization token and host not on allowlist' };
    }
    if (SPENT.has(token)) {
        return { allowed: false, code: 'TOKEN_SPENT', reason: 'token already used' };
    }
    const entry = TOKENS.get(token);
    if (!entry) {
        return { allowed: false, code: 'TOKEN_UNKNOWN', reason: 'unknown token' };
    }
    if (Date.now() > entry.expiresAt) {
        return { allowed: false, code: 'TOKEN_EXPIRED', reason: 'token expired' };
    }
    if (entry.host !== host) {
        // Domain-binding: a token minted for a.customer.com must not authorize
        // b.attacker.com even if it leaks. This is the key property.
        return { allowed: false, code: 'TOKEN_HOST_MISMATCH', reason: 'token not valid for this host' };
    }

    // Valid: burn the token (single-use) and allow.
    SPENT.add(token);
    TOKENS.delete(token);
    return { allowed: true, meta: { via: 'token' } };
}

module.exports = { authorize, mintToken };
