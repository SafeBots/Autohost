// src/autohost.js
//
// On-demand vhost provisioner. Engine-agnostic (nginx or Apache). Pluggable
// cert providers (Let's Encrypt, Cloudflare Origin CA, CloudFront, none).
//
// Flow:
//   1. Web server forwards unknown-Host requests to the autohost Unix socket
//   2. autohost validates the hostname
//   3. If behind a CDN (provider == cloudflare/cloudfront): skip DNS check,
//      use provider's origin cert directly
//   4. Otherwise: check DNS resolves to us (multi-resolver), then ACME
//   5. Write per-host vhost + cert
//   6. Trigger graceful reload (zero-downtime)
//
// The web server always serves a static "preparing" splash to the requesting
// user while this happens in the background.

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const dnsClient = require('./dnsCheck');
const config    = require('./config');
const logger    = require('./logger');
const rateLimit = require('./rateLimit');

const cfg = config.load();
const log = logger.create('autohost', cfg.logLevel);

const engineModules = {
    'nginx':  './engines/nginx',
    'apache': './engines/apache',
};

function loadEngine(name) {
    if (!engineModules[name]) {
        throw new Error(`unknown web server engine: ${name}; available: ${Object.keys(engineModules).join(', ')}`);
    }
    return require(engineModules[name]).create(cfg);
}

const engine = loadEngine(cfg.engine);

const providerModules = {
    'letsencrypt': './providers/letsencrypt',
    'cloudflare':  './providers/cloudflare',
    'cloudfront':  './providers/cloudfront',
    'none':        './providers/none',
};

function loadProvider(name) {
    if (!providerModules[name]) {
        throw new Error(`unknown cert provider: ${name}; available: ${Object.keys(providerModules).join(', ')}`);
    }
    return require(providerModules[name]).create(cfg);
}

const provider = loadProvider(cfg.provider);
log.info('startup', {
    engine: engine.name,
    provider: provider.name,
    version: require('../package.json').version,
});

const isCdnMode = (cfg.provider === 'cloudflare' || cfg.provider === 'cloudfront');

const inflight       = new Map();
const installedHosts = new Set();
const dnsNegCache    = new Map();
const certNegCache   = new Map();

const HOST_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const HOST_MAX_LEN = 253;

function isValidHostname(host) {
    if (typeof host !== 'string') return false;
    if (host.length === 0 || host.length > HOST_MAX_LEN) return false;
    if (host.startsWith('-') || host.endsWith('-')) return false;
    return HOST_REGEX.test(host);
}

function checkNegCache(cache, host) {
    const entry = cache.get(host);
    if (!entry) return null;
    if (entry.expiryMs <= Date.now()) { cache.delete(host); return null; }
    return entry.reason;
}

function addNegCache(cache, host, reason, ttlMs) {
    cache.set(host, { reason, expiryMs: Date.now() + ttlMs });
}

let pendingReload  = false;
let reloadInFlight = false;
let lastReloadAt   = 0;

function queueReload() {
    if (reloadInFlight) { pendingReload = true; return; }
    const sinceLast = Date.now() - lastReloadAt;
    if (sinceLast < cfg.reloadDebounceMs) {
        if (!pendingReload) {
            pendingReload = true;
            setTimeout(doReload, cfg.reloadDebounceMs - sinceLast);
        }
        return;
    }
    doReload();
}

async function doReload() {
    if (reloadInFlight) { pendingReload = true; return; }
    reloadInFlight = true;
    pendingReload  = false;
    lastReloadAt   = Date.now();

    const validation = await engine.validateConfig();
    if (!validation.ok) {
        log.error('engine_config_invalid', { engine: engine.name, stderr: validation.stderr });
        reloadInFlight = false;
        if (pendingReload) { pendingReload = false; setTimeout(doReload, cfg.reloadDebounceMs); }
        return;
    }

    const reloadResult = await engine.reload();
    reloadInFlight = false;
    if (!reloadResult.ok) {
        log.error('engine_reload_failed', { engine: engine.name, stderr: reloadResult.stderr });
    } else {
        log.info('engine_reload_ok', { engine: engine.name });
    }
    if (pendingReload) { pendingReload = false; setTimeout(doReload, cfg.reloadDebounceMs); }
}

async function installVhost(host, cert, key) {
    await fs.promises.mkdir(cfg.certDir, { recursive: true, mode: 0o750 });
    await fs.promises.mkdir(cfg.vhostDir, { recursive: true, mode: 0o755 });

    const certPath = path.join(cfg.certDir, `${host}.crt`);
    const keyPath  = path.join(cfg.certDir, `${host}.key`);
    const certTmp  = certPath + '.tmp.' + process.pid;
    const keyTmp   = keyPath  + '.tmp.' + process.pid;

    await fs.promises.writeFile(certTmp, cert, { mode: 0o640 });
    await fs.promises.writeFile(keyTmp,  key,  { mode: 0o640 });
    await fs.promises.rename(certTmp, certPath);
    await fs.promises.rename(keyTmp,  keyPath);

    const confPath = path.join(cfg.vhostDir, `${host}${engine.vhostFileExtension}`);
    const confTmp  = confPath + '.tmp.' + process.pid;
    const vhostConfig = engine.vhostConfigFor(host, certPath, keyPath, {
        proxyTarget: cfg.proxyTarget,
    });
    await fs.promises.writeFile(confTmp, vhostConfig, { mode: 0o644 });
    await fs.promises.rename(confTmp, confPath);

    log.info('vhost_installed', { host, engine: engine.name });
    queueReload();
}

async function provision(host, requestIp) {
    if (!isValidHostname(host)) {
        return { status: 'error', code: 'INVALID_HOST', message: 'invalid hostname format' };
    }

    if (installedHosts.has(host)) {
        return { status: 'ok', code: 'ALREADY_INSTALLED' };
    }

    const dnsNeg = checkNegCache(dnsNegCache, host);
    if (dnsNeg) return { status: 'error', code: 'DNS_MISMATCH_CACHED', message: dnsNeg };
    const certNeg = checkNegCache(certNegCache, host);
    if (certNeg) return { status: 'error', code: 'CERT_FAILED_CACHED', message: certNeg };

    if (requestIp && !rateLimit.allowPerIp(requestIp)) {
        return { status: 'error', code: 'RATE_LIMITED_IP', message: 'too many requests from this source' };
    }
    if (!rateLimit.allowGlobal()) {
        return { status: 'error', code: 'RATE_LIMITED_GLOBAL', message: 'box-wide rate limit reached' };
    }

    const existing = inflight.get(host);
    if (existing) return existing;

    const promise = (async () => {
        try {
            if (!isCdnMode) {
                const ourIps = await cfg.discoverOurIps();
                const dnsResult = await dnsClient.resolveAcrossResolvers(host, cfg.dnsResolvers);
                const matches = dnsResult.ips.some(ip => ourIps.has(ip));

                if (!matches) {
                    const reason = dnsResult.ips.length === 0
                        ? `dns_no_records:${dnsResult.errors.join(',')}`
                        : `dns_points_elsewhere:${dnsResult.ips.slice(0, 3).join(',')}`;
                    addNegCache(dnsNegCache, host, reason, cfg.dnsMismatchCacheMs);
                    log.info('provision_skipped_dns', { host, reason });
                    return { status: 'error', code: 'DNS_MISMATCH', message: reason };
                }
            } else {
                log.info('provision_skipping_dns_cdn_mode', { host, provider: cfg.provider });
            }

            log.info('provision_starting', { host, provider: cfg.provider });
            const { cert, key } = await provider.provisionCert(host);
            await installVhost(host, cert, key);
            installedHosts.add(host);
            log.info('provision_completed', { host });
            return { status: 'ok', code: 'INSTALLED' };
        } catch (e) {
            const reason = `${e.code || 'CERT_ERROR'}:${(e.message || '').slice(0, 200)}`;
            addNegCache(certNegCache, host, reason, cfg.certFailCacheMs);
            log.error('provision_failed', { host, code: e.code, message: e.message });
            return { status: 'error', code: e.code || 'CERT_FAILED', message: reason };
        } finally {
            inflight.delete(host);
        }
    })();
    inflight.set(host, promise);
    return promise;
}

function startServer() {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/provision') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{"status":"error","code":"NOT_FOUND"}');
            return;
        }
        let body = '';
        let aborted = false;
        req.on('data', (c) => {
            body += c;
            if (body.length > cfg.maxRequestBytes) {
                aborted = true;
                res.writeHead(413); res.end(); req.destroy();
            }
        });
        req.on('end', async () => {
            if (aborted) return;
            let parsed;
            try { parsed = JSON.parse(body); }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end('{"status":"error","code":"BAD_REQUEST","message":"invalid JSON"}');
                return;
            }
            try {
                const result = await module.exports.provision(parsed.host, parsed.requestIp);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (e) {
                log.error('handler_failed', { message: e.message });
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'error', code: 'INTERNAL', message: e.message }));
            }
        });
    });

    try { fs.unlinkSync(cfg.socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.mkdirSync(path.dirname(cfg.socketPath), { recursive: true, mode: 0o755 });
    server.listen(cfg.socketPath, () => {
        try { fs.chmodSync(cfg.socketPath, 0o660); } catch {}
        log.info('listening', {
            socket: cfg.socketPath,
            engine: engine.name,
            provider: provider.name,
            cdnMode: isCdnMode,
        });
    });
    server.on('error', (e) => log.error('server_error', { message: e.message }));
    return server;
}

function installSignalHandlers(server) {
    const shutdown = () => {
        log.info('shutting_down');
        if (server) server.close();
        setTimeout(() => process.exit(0), 1000);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT',  shutdown);
}

if (require.main === module) {
    const server = startServer();
    installSignalHandlers(server);
}

module.exports = {
    _isValidHostname: isValidHostname,
    _queueReload:     queueReload,
    _resetReloadState: () => {
        pendingReload = false;
        reloadInFlight = false;
        lastReloadAt = 0;
    },
    _engine:    engine,
    _provider:  provider,
    _isCdnMode: isCdnMode,
    provision,
    startServer,
    installVhost,
};
