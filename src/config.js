// src/config.js
//
// Configuration loader. Reads /etc/autohost/config.json (if present) and
// overlays environment variables. Auto-detects environment things like
// nginx binary path, nginx config dir, public IPs.
//
// All settings can be overridden in three places, in this priority order:
//   1. Environment variable (e.g. AUTOVHOST_PROVIDER=cloudflare)
//   2. /etc/autohost/config.json
//   3. Built-in defaults
//
// Auto-detected things are computed at load time and cached.

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

// ── Defaults ─────────────────────────────────────────────────────────────────
//
// These are the safest sensible defaults. Most should work out of the box on
// Debian/Ubuntu/RHEL/Amazon Linux/Alpine.

const DEFAULTS = {
    // Web server engine: 'nginx' or 'apache'. We auto-detect when null.
    engine: null,

    // Provider: 'letsencrypt' (default), 'cloudflare', 'cloudfront', or 'none'
    provider: 'letsencrypt',

    // Where the autohost Unix socket lives. The engine connects here.
    socketPath: '/run/autohost/autohost.sock',

    // Where provisioned vhost configs go.
    vhostDir: '/etc/nginx/conf.d/auto',   // overridden for Apache by detection

    // Where provisioned certs go.
    certDir: '/etc/nginx/conf.d/auto-certs',   // overridden for Apache by detection

    // Shared ACME HTTP-01 challenges directory. The web server is configured
    // to serve /.well-known/acme-challenge/<token> from this dir for ALL hosts.
    acmeChallengesRoot: '/var/lib/autohost',

    // ACME state
    acmeAccountKeyPath: '/var/lib/autohost/acme-account.key',
    acmeContactEmail: null,
    acmeStaging: false,

    // Reload debounce
    reloadDebounceMs: 2000,

    // Negative cache TTLs
    dnsMismatchCacheMs: 5 * 60 * 1000,
    certFailCacheMs:    60 * 60 * 1000,

    // Rate limits
    perIpLimitPerHour:  10,
    globalLimitPerHour: 100,

    // ── Optional authorization hook ──────────────────────────────────────
    // Path to a Node module that decides whether a given host is allowed to
    // be provisioned, BEYOND the built-in DNS/CDN check. Null (default) means
    // "no extra authorization" — behaviour is exactly as before: any host that
    // passes the DNS-points-at-us check (or CDN mode) gets provisioned.
    //
    // When set, the module is require()'d once at startup and must export a
    // function (or { authorize } object) with the signature:
    //
    //     async authorize(host, context) -> { allowed: boolean, reason?, code?, meta? }
    //
    //   host    : the requested hostname (already format-validated)
    //   context : { requestIp, headers, provider, isCdnMode }
    //
    // The hook runs AFTER the DNS/CDN check and rate limit, but BEFORE any
    // cert is provisioned — so it can gate expensive ACME work behind, e.g.,
    // a single-use domain-bound token, an allowlist, a per-project quota, or a
    // call into an external control plane. Returning { allowed: false } skips
    // provisioning and returns the reason to the caller; the host is NOT
    // negative-cached (it may become allowed shortly, e.g. quota frees up).
    //
    // This is the seam multi-tenant platforms (e.g. Safebox) use to enforce
    // "which project may add this domain" without forking Autohost. If the hook
    // module throws at load time, startup fails loudly rather than silently
    // running unauthorized — a missing/broken authorizer must never fail open.
    authorizeHook: null,

    // If true and authorizeHook is set but fails to LOAD, refuse to start.
    // (A hook that is configured but broken must not silently disappear,
    // leaving provisioning wide open.) Default true.
    authorizeHookRequired: true,

    // DNS resolvers — system + public resolvers in parallel, any match accepted
    dnsResolvers: ['system', '1.1.1.1', '8.8.8.8'],

    // Where customer traffic gets proxied to once a vhost is installed
    proxyTarget: '127.0.0.1:3000',

    // Per-host vhost template path. If null or the file doesn't exist, the
    // engine's built-in default template is used. Set to a path to override
    // — operators edit ONE file (typically /etc/autohost/vhost-template.conf)
    // to customize what generated vhosts look like (location blocks, try_files,
    // per-hostname document roots, custom headers, WAF rules, anything).
    //
    // Available placeholders in the template: {{hostname}}, {{certPath}},
    // {{keyPath}}, {{proxyTarget}}, {{acmeChallengesRoot}}.
    vhostTemplatePath: '/etc/autohost/vhost-template.conf',

    // Web server binaries (auto-detected when null)
    nginxBinary:  null,
    apacheBinary: null,

    // Public IPs of this box (auto-detected via cloud metadata or echo services)
    ourIps: null,
    ourIpsCacheMs: 5 * 60 * 1000,

    // Max request body size on the Unix socket
    maxRequestBytes: 4096,

    // Log level
    logLevel: 'info',
};

// ── Auto-detect nginx binary ─────────────────────────────────────────────────

function detectNginxBinary() {
    const candidates = [
        '/usr/sbin/nginx',
        '/usr/local/sbin/nginx',
        '/usr/local/bin/nginx',
        '/opt/nginx/sbin/nginx',
        '/usr/local/openresty/nginx/sbin/nginx',
    ];
    for (const p of candidates) {
        try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
    return 'nginx';
}

// ── Auto-detect Apache binary ────────────────────────────────────────────────

function detectApacheBinary() {
    // apachectl is the recommended wrapper; on some distros it's apache2ctl.
    const candidates = [
        '/usr/sbin/apachectl',
        '/usr/sbin/apache2ctl',
        '/usr/local/sbin/apachectl',
        '/usr/local/apache2/bin/apachectl',
    ];
    for (const p of candidates) {
        try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
    }
    return null;
}

// ── Auto-detect web server engine ────────────────────────────────────────────
//
// Look for the running web server. nginx wins if both are installed (more
// common in our target use case). Operator can override via env or config.

function detectEngine() {
    // First: check if either binary is present and executable
    const hasNginx  = detectNginxBinary() !== 'nginx' || nginxOnPath();
    const hasApache = detectApacheBinary() !== null;
    if (hasNginx && !hasApache) return 'nginx';
    if (!hasNginx && hasApache) return 'apache';
    if (hasNginx && hasApache) return 'nginx';  // tie-break: prefer nginx
    return 'nginx';  // default fallback
}

function nginxOnPath() {
    // Crude check: is 'nginx' on PATH?
    const pathDirs = (process.env.PATH || '').split(':');
    for (const d of pathDirs) {
        try {
            fs.accessSync(path.join(d, 'nginx'), fs.constants.X_OK);
            return true;
        } catch {}
    }
    return false;
}

// ── Auto-detect Apache conf.d ────────────────────────────────────────────────

function detectApacheVhostDir() {
    const candidates = [
        '/etc/apache2/sites-enabled',     // Debian/Ubuntu
        '/etc/httpd/conf.d',              // RHEL/CentOS/Fedora
        '/etc/apache2/conf.d',
        '/usr/local/apache2/conf/extra',
    ];
    for (const p of candidates) {
        try { fs.accessSync(p, fs.constants.W_OK); return p; } catch {}
    }
    return '/etc/apache2/sites-enabled';  // best guess
}

// ── Auto-detect nginx conf.d ─────────────────────────────────────────────────

function detectNginxConfD() {
    const candidates = [
        '/etc/nginx/conf.d',
        '/usr/local/etc/nginx/conf.d',
        '/opt/nginx/conf/conf.d',
    ];
    for (const p of candidates) {
        try {
            fs.accessSync(p, fs.constants.R_OK);
            return p;
        } catch {}
    }
    return '/etc/nginx/conf.d';  // best guess
}

// ── Public IP discovery (cloud-aware) ────────────────────────────────────────
//
// Tries (in order): AWS IMDSv2, Azure IMDS, GCP metadata, public echo
// services. The result is cached for ourIpsCacheMs.

let ourIpsCache = null;
let ourIpsExpiry = 0;

function httpGet(opts) {
    return new Promise((resolve, reject) => {
        const req = http.request(Object.assign({ timeout: 2000 }, opts), (res) => {
            let buf = '';
            res.on('data', (c) => buf += c);
            res.on('end', () => {
                if (res.statusCode === 200) resolve(buf.trim());
                else reject(new Error(`status ${res.statusCode}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (opts.method === 'PUT') req.end();
        else req.end();
    });
}

async function discoverIpAws() {
    const token = await httpGet({
        method: 'PUT',
        host: '169.254.169.254',
        path: '/latest/api/token',
        headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
    });
    return httpGet({
        method: 'GET',
        host: '169.254.169.254',
        path: '/latest/meta-data/public-ipv4',
        headers: { 'X-aws-ec2-metadata-token': token },
    });
}

async function discoverIpAzure() {
    return httpGet({
        method: 'GET',
        host: '169.254.169.254',
        path: '/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text',
        headers: { 'Metadata': 'true' },
    });
}

async function discoverIpGcp() {
    return httpGet({
        method: 'GET',
        host: 'metadata.google.internal',
        path: '/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip',
        headers: { 'Metadata-Flavor': 'Google' },
    });
}

async function discoverIpPublic() {
    // Try a couple of well-known echo services
    const services = ['api.ipify.org', 'icanhazip.com', 'ifconfig.me'];
    for (const svc of services) {
        try {
            return await new Promise((resolve, reject) => {
                const req = require('https').get({ host: svc, path: '/', timeout: 3000 }, (res) => {
                    let buf = '';
                    res.on('data', (c) => buf += c);
                    res.on('end', () => resolve(buf.trim()));
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            });
        } catch {}
    }
    throw new Error('all public IP echo services failed');
}

async function discoverOurIpsImpl(staticIps) {
    if (Array.isArray(staticIps) && staticIps.length > 0) return new Set(staticIps);

    const tryers = [discoverIpAws, discoverIpAzure, discoverIpGcp, discoverIpPublic];
    for (const fn of tryers) {
        try {
            const ip = await fn();
            if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
                return new Set([ip]);
            }
        } catch {}
    }
    throw new Error('could not auto-detect public IP; set ourIps explicitly in config');
}

// ── Load config + env overrides ──────────────────────────────────────────────

function envOverrides() {
    const e = process.env;
    const out = {};
    if (e.AUTOVHOST_ENGINE)              out.engine = e.AUTOVHOST_ENGINE;
    if (e.AUTOVHOST_PROVIDER)            out.provider = e.AUTOVHOST_PROVIDER;
    if (e.AUTOVHOST_SOCKET_PATH)         out.socketPath = e.AUTOVHOST_SOCKET_PATH;
    if (e.AUTOVHOST_VHOST_DIR)           out.vhostDir = e.AUTOVHOST_VHOST_DIR;
    if (e.AUTOVHOST_CERT_DIR)            out.certDir = e.AUTOVHOST_CERT_DIR;
    if (e.AUTOVHOST_ACME_CHALLENGES_ROOT) out.acmeChallengesRoot = e.AUTOVHOST_ACME_CHALLENGES_ROOT;
    if (e.AUTOVHOST_ACME_CONTACT_EMAIL)  out.acmeContactEmail = e.AUTOVHOST_ACME_CONTACT_EMAIL;
    if (e.AUTOVHOST_ACME_STAGING)        out.acmeStaging = e.AUTOVHOST_ACME_STAGING === 'true';
    if (e.AUTOVHOST_PROXY_TARGET)        out.proxyTarget = e.AUTOVHOST_PROXY_TARGET;
    if (e.AUTOVHOST_VHOST_TEMPLATE_PATH) out.vhostTemplatePath = e.AUTOVHOST_VHOST_TEMPLATE_PATH;
    if (e.AUTOVHOST_NGINX_BINARY)        out.nginxBinary = e.AUTOVHOST_NGINX_BINARY;
    if (e.AUTOVHOST_APACHE_BINARY)       out.apacheBinary = e.AUTOVHOST_APACHE_BINARY;
    if (e.AUTOVHOST_OUR_IPS)             out.ourIps = e.AUTOVHOST_OUR_IPS.split(',').map(s => s.trim());
    if (e.AUTOVHOST_LOG_LEVEL)           out.logLevel = e.AUTOVHOST_LOG_LEVEL;
    if (e.AUTOVHOST_RELOAD_DEBOUNCE_MS)  out.reloadDebounceMs = parseInt(e.AUTOVHOST_RELOAD_DEBOUNCE_MS, 10);
    if (e.AUTOVHOST_PER_IP_LIMIT_PER_HOUR) out.perIpLimitPerHour = parseInt(e.AUTOVHOST_PER_IP_LIMIT_PER_HOUR, 10);
    if (e.AUTOVHOST_GLOBAL_LIMIT_PER_HOUR) out.globalLimitPerHour = parseInt(e.AUTOVHOST_GLOBAL_LIMIT_PER_HOUR, 10);
    if (e.AUTOVHOST_AUTHORIZE_HOOK)        out.authorizeHook = e.AUTOVHOST_AUTHORIZE_HOOK;
    if (e.AUTOVHOST_AUTHORIZE_HOOK_REQUIRED) out.authorizeHookRequired = e.AUTOVHOST_AUTHORIZE_HOOK_REQUIRED === 'true';
    return out;
}

function load() {
    const configPath = process.env.AUTOVHOST_CONFIG || '/etc/autohost/config.json';
    let fileOverrides = {};
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        fileOverrides = JSON.parse(raw);
        if (typeof fileOverrides !== 'object' || fileOverrides === null || Array.isArray(fileOverrides)) {
            throw new Error('config must be a JSON object');
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw new Error(`autohost config malformed at ${configPath}: ${e.message}`);
        }
    }

    const merged = Object.assign({}, DEFAULTS, fileOverrides, envOverrides());

    // Engine detection
    if (!merged.engine) merged.engine = detectEngine();

    // Binary auto-detection
    if (!merged.nginxBinary)  merged.nginxBinary  = detectNginxBinary();
    if (!merged.apacheBinary) merged.apacheBinary = detectApacheBinary() || 'apachectl';

    // Engine-specific path defaults if user didn't override
    if (merged.engine === 'apache') {
        if (merged.vhostDir === DEFAULTS.vhostDir) merged.vhostDir = detectApacheVhostDir();
        if (merged.certDir === DEFAULTS.certDir)   merged.certDir = '/etc/autohost/certs';
    }

    // discoverOurIps is a function that returns a Set of IPs, with caching
    merged.discoverOurIps = async () => {
        const now = Date.now();
        if (ourIpsCache && ourIpsExpiry > now) return ourIpsCache;
        ourIpsCache = await discoverOurIpsImpl(merged.ourIps);
        ourIpsExpiry = now + merged.ourIpsCacheMs;
        return ourIpsCache;
    };

    return merged;
}

module.exports = {
    load,
    DEFAULTS,
    _detectNginxBinary:  detectNginxBinary,
    _detectApacheBinary: detectApacheBinary,
    _detectEngine:       detectEngine,
    _detectNginxConfD:   detectNginxConfD,
    _detectApacheVhostDir: detectApacheVhostDir,
    _discoverOurIpsImpl:   discoverOurIpsImpl,
};
