// src/renew.js
//
// Periodic cert renewal. Run as a systemd timer (daily). For each
// installed vhost cert that expires within 30 days, re-runs the provider's
// renewCert flow and atomically replaces the cert files.
//
// Run as: node /opt/autohost/renew.js
// Schedule: systemd timer (provided in units/autohost-renew.timer)

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');
const logger = require('./logger');

const cfg = config.load();
const log = logger.create('autohost-renew', cfg.logLevel);

const providerModules = {
    'letsencrypt': './providers/letsencrypt',
    'cloudflare':  './providers/cloudflare',
    'cloudfront':  './providers/cloudfront',
    'none':        './providers/none',
};
const provider = require(providerModules[cfg.provider]).create(cfg);

const engineModules = {
    'nginx':  './engines/nginx',
    'apache': './engines/apache',
};
const engine = require(engineModules[cfg.engine]).create(cfg);

const RENEW_BEFORE_DAYS = 30;

function certExpiryDays(certPath) {
    try {
        const pem = fs.readFileSync(certPath, 'utf8');
        const cert = new crypto.X509Certificate(pem);
        const validTo = new Date(cert.validTo);
        return Math.floor((validTo.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    } catch (e) {
        return null;
    }
}

async function renewOne(host) {
    log.info('renew_starting', { host });
    const result = await provider.renewCert(host);

    const certPath = path.join(cfg.certDir, `${host}.crt`);
    const keyPath  = path.join(cfg.certDir, `${host}.key`);

    // Atomic write
    const certTmp = certPath + '.tmp.' + process.pid;
    const keyTmp  = keyPath  + '.tmp.' + process.pid;
    fs.writeFileSync(certTmp, result.cert, { mode: 0o640 });
    fs.writeFileSync(keyTmp,  result.key,  { mode: 0o640 });
    fs.renameSync(certTmp, certPath);
    fs.renameSync(keyTmp,  keyPath);

    log.info('renew_completed', { host });
}

async function main() {
    let certs;
    try {
        certs = fs.readdirSync(cfg.certDir).filter(f => f.endsWith('.crt'));
    } catch (e) {
        if (e.code === 'ENOENT') {
            log.info('no_certs_to_renew');
            return;
        }
        throw e;
    }

    let renewed = 0;
    let errors = 0;

    for (const certFile of certs) {
        const host = certFile.replace(/\.crt$/, '');
        const certPath = path.join(cfg.certDir, certFile);
        const daysLeft = certExpiryDays(certPath);

        if (daysLeft === null) {
            log.warn('cert_unparseable', { host });
            continue;
        }
        if (daysLeft > RENEW_BEFORE_DAYS) {
            log.debug('cert_not_due', { host, daysLeft });
            continue;
        }

        try {
            await renewOne(host);
            renewed++;
        } catch (e) {
            log.error('renew_failed', { host, message: e.message });
            errors++;
        }
    }

    log.info('renew_pass_complete', { renewed, errors, totalChecked: certs.length });

    // Reload the web server if any certs were renewed (so new cert is loaded).
    // Routes through the engine, so Apache deployments reload Apache, nginx
    // deployments reload nginx.
    if (renewed > 0) {
        const result = await engine.reload();
        if (result.ok) {
            log.info('engine_reload_ok', { engine: engine.name });
        } else {
            log.error('engine_reload_failed', { engine: engine.name, stderr: result.stderr });
        }
    }
}

if (require.main === module) {
    main().catch((e) => {
        log.error('renew_pass_failed', { message: e.message, stack: e.stack });
        process.exit(1);
    });
}

module.exports = { main, _certExpiryDays: certExpiryDays };
