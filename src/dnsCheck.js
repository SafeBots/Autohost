// src/dnsCheck.js
//
// Multi-resolver DNS check. Queries the system resolver plus a configurable
// list of public resolvers (1.1.1.1, 8.8.8.8 etc.) and returns ANY IP that
// any resolver returned. We accept any positive match — handles DNS
// propagation lag where the system resolver hasn't refreshed but a public
// resolver has.

'use strict';

const dns = require('dns');
const { Resolver } = require('dns').promises;

const SYSTEM_RESOLVER = 'system';

async function resolveOne(host, resolverIp) {
    if (resolverIp === SYSTEM_RESOLVER) {
        try {
            return await require('dns').promises.resolve4(host);
        } catch (e) {
            throw new Error(`system:${e.code || e.message}`);
        }
    }
    const resolver = new Resolver({ timeout: 3000, tries: 1 });
    resolver.setServers([resolverIp]);
    try {
        return await resolver.resolve4(host);
    } catch (e) {
        throw new Error(`${resolverIp}:${e.code || e.message}`);
    }
}

// Query all resolvers in parallel; return ALL unique IPs from any positive
// response, plus a list of error tags from negative responses.
async function resolveAcrossResolvers(host, resolverIps) {
    const results = await Promise.allSettled(
        resolverIps.map(r => resolveOne(host, r))
    );
    const ips = new Set();
    const errors = [];
    for (const r of results) {
        if (r.status === 'fulfilled') {
            for (const ip of r.value) ips.add(ip);
        } else {
            errors.push(r.reason.message);
        }
    }
    return { ips: Array.from(ips), errors };
}

module.exports = { resolveAcrossResolvers, _resolveOne: resolveOne };
