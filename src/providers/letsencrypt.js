// src/providers/letsencrypt.js
//
// Let's Encrypt cert provider via ACME HTTP-01. Uses acme-client npm
// package. The shared challenges directory is configured in autohost
// config; nginx serves /.well-known/acme-challenge/<token> for ALL hosts
// from that directory via a static catch-all server block.

'use strict';

const fs   = require('fs');
const path = require('path');
const acme = require('acme-client');

function create(cfg) {
    let clientInstance = null;
    let accountKeyCached = null;

    async function getAccountKey() {
        if (accountKeyCached) return accountKeyCached;
        try {
            accountKeyCached = fs.readFileSync(cfg.acmeAccountKeyPath);
            return accountKeyCached;
        } catch (e) {
            if (e.code !== 'ENOENT') throw e;
        }
        const key = await acme.crypto.createPrivateKey();
        fs.mkdirSync(path.dirname(cfg.acmeAccountKeyPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(cfg.acmeAccountKeyPath, key, { mode: 0o600 });
        accountKeyCached = key;
        return key;
    }

    async function getClient() {
        if (clientInstance) return clientInstance;
        const accountKey = await getAccountKey();
        const directoryUrl = cfg.acmeStaging
            ? acme.directory.letsencrypt.staging
            : acme.directory.letsencrypt.production;
        clientInstance = new acme.Client({ directoryUrl, accountKey });
        await clientInstance.createAccount({
            termsOfServiceAgreed: true,
            contact: cfg.acmeContactEmail ? [`mailto:${cfg.acmeContactEmail}`] : undefined,
        });
        return clientInstance;
    }

    async function provisionCert(host) {
        const client = await getClient();
        const [key, csr] = await acme.crypto.createCsr({ commonName: host });

        const cert = await client.auto({
            csr,
            email: cfg.acmeContactEmail,
            termsOfServiceAgreed: true,
            challengePriority: ['http-01'],
            challengeCreateFn: async (authz, challenge, keyAuthorization) => {
                const challengesDir = path.join(cfg.acmeChallengesRoot, '.well-known', 'acme-challenge');
                await fs.promises.mkdir(challengesDir, { recursive: true, mode: 0o755 });
                const tokenPath = path.join(challengesDir, challenge.token);
                await fs.promises.writeFile(tokenPath, keyAuthorization, { mode: 0o644 });
            },
            challengeRemoveFn: async (authz, challenge) => {
                const challengesDir = path.join(cfg.acmeChallengesRoot, '.well-known', 'acme-challenge');
                const tokenPath = path.join(challengesDir, challenge.token);
                try { await fs.promises.unlink(tokenPath); } catch {}
            },
        });

        return { cert: cert.toString(), key: key.toString() };
    }

    return {
        name: 'letsencrypt',
        provisionCert,
        renewCert: provisionCert,  // renewal is the same flow
    };
}

module.exports = { create };
