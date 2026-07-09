<img src="https://safebots.ai/img/safebots/safebots.webp" style="width: 300px;">

# Autohost

**On-demand vhost provisioning for nginx and Apache. Customer points DNS at your server, hits the URL, gets a real cert + working vhost in seconds. Zero-downtime graceful reload, no manual cert management, pluggable cert providers (Let's Encrypt, Cloudflare Origin CA, CloudFront).**

[![Tests](https://img.shields.io/badge/tests-167%2F167-green.svg)](#testing)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-blue.svg)](#requirements)

---

## What it does

You run a web server (nginx or Apache) with multi-tenant traffic. Customers point their own domains (`app.acme.com`, `admin.foobar.com`, etc.) at your server's IP. You want each one to "just work" — HTTPS with a real browser-trusted cert, no manual setup per customer, no service restart for every new domain.

Autohost handles this:

1. **Catches unknown-Host requests** in your web server via a catch-all default_server / default VirtualHost
2. **Serves a branded "Provisioning HTTPS" splash** to the user while work happens in the background
3. **Checks DNS** (multi-resolver: system + 1.1.1.1 + 8.8.8.8) that the hostname points at your server
4. **Provisions a real TLS cert** via your chosen provider:
   - **Let's Encrypt** (default) — ACME HTTP-01, browser-trusted, free
   - **Cloudflare Origin CA** — 15-year cert for use behind Cloudflare CDN
   - **CloudFront SaaS Manager** — origin cert (partial implementation; CDN-side alias registration is TODO)
   - **none** — self-signed for testing
5. **Writes the per-host vhost + cert** to your web server's config dir
6. **Triggers a graceful reload** (`nginx -s reload` or `apachectl graceful`) — zero downtime, no dropped connections
7. **Auto-renews certs** via a daily systemd timer

Subsequent requests for that hostname go straight to the customer's real vhost.

## What the user sees

**First HTTP visit to a new hostname:** Splash served immediately, plain HTTP, no warning. Auto-refreshes every 10 seconds. Within ~30 seconds, refresh lands on the real vhost.

**First HTTPS visit to a new hostname:** TLS handshake completes with a bootstrap self-signed cert. Browser warns "your connection is not private." User clicks through, sees splash, refreshes after a minute, gets the real Let's Encrypt cert with no warning.

The warning on first HTTPS visit is unavoidable — there is fundamentally no way for any server to present a cert browsers trust for a hostname that has never been seen before. Even Cloudflare-for-SaaS handles this by pre-validating hostnames before traffic flows. **The first-HTTPS warning is a one-time event for each new hostname.** All subsequent visits use the provisioned cert.

If you want to skip the warning entirely, point customers to **HTTP first** (e.g., `http://newcustomer.com`). Most modern browsers will try HTTPS first by default, but customer onboarding emails / documentation can lead with HTTP and recommend the cert provisions before HTTPS is needed. Or, behind a CDN (Cloudflare/CloudFront), the CDN provides browser TLS and our origin only needs a cert the CDN trusts — see "CDN mode" below.

## Why this exists

If you're building a multi-tenant SaaS where customers attach their own domains, the standard solutions are:

- **Manually configure each vhost.** Doesn't scale; ops bottleneck.
- **Use a CDN like Cloudflare for SaaS.** Works, but per-hostname fees, third-party in your cleartext path, less control.
- **Use a wildcard cert and SNI matching.** Doesn't work for arbitrary customer domains.
- **Run Caddy instead of nginx.** Solves it, but you've now bought into Caddy.
- **mod_md for Apache.** Native Apache solution, but only does Let's Encrypt, not multi-provider.

Autohost is the "stay on your existing web server, add ~700 lines of Node" version. Small enough to read in an afternoon, generic enough to drop into most existing setups, and pluggable enough to swap providers based on which CDN strategy (if any) you've picked.

## Engines

Autohost supports two web server engines. Auto-detected at install time based on which binary is present.

### nginx (recommended)

- Uses nginx's `mirror` directive to fire-and-forget the provisioning trigger while serving the splash
- Reload is `nginx -s reload` (graceful, since nginx 0.x)
- Catch-all uses `default_server` directive on port 80 and 443
- Most polished integration; this is what we originally designed for

### Apache

- Uses a small CGI helper (`/opt/Autohost/scripts/Autohost-trigger.sh`) invoked by mod_rewrite when an unknown host hits the catch-all VirtualHost. The helper does a one-shot `curl --unix-socket` POST to the Autohost socket in the background, then serves the splash. Apache lacks nginx's `mirror` directive, so this is how the trigger fires asynchronously.
- Reload is `apachectl graceful` (same zero-downtime semantics as nginx).
- Per-host vhosts are written to `/etc/Autohost/sites/<host>.conf` rather than Debian's normal `/etc/apache2/sites-enabled/` or RHEL's `/etc/httpd/conf.d/`. The catch-all uses `IncludeOptional /etc/Autohost/sites/*.conf` to pull them in. The reason: avoiding collisions with whatever else lives in your Apache config tree, and giving Autohost a single writable directory to manage.
- Requires modules: `mod_ssl`, `mod_proxy`, `mod_proxy_http`, `mod_headers`, `mod_rewrite`, `mod_alias`, `mod_cgi`. On Debian/Ubuntu, the installer runs `a2enmod ssl rewrite headers proxy proxy_http cgi alias` automatically. On RHEL/Fedora the modules are typically built-in and loaded by default. On source-built Apache, ensure all of these are enabled in `httpd.conf` before starting Autohost.

If you only need Let's Encrypt and you're on Apache, consider [mod_md](https://httpd.apache.org/docs/2.4/mod/mod_md.html) — it does ACME natively and is built into Apache 2.4.30+. Autohost-for-apache is useful when you want the multi-provider abstraction (Cloudflare origin certs, CloudFront origin certs) on Apache, or when you want consistent operational behavior across nginx and Apache deployments.

## CDN mode (Cloudflare, CloudFront)

When the cert provider is `cloudflare` or `cloudfront`, Autohost runs in **CDN mode**:

- **DNS pre-check is skipped.** The CDN already validated the hostname on its side. No external DNS lookups, no waiting on propagation. Provisioning is near-instant.
- **The cert is for the CDN→origin leg, not for the browser.** The CDN (Cloudflare or CloudFront) handles browser TLS with its own managed cert. Our origin cert just needs to be one the CDN accepts.
  - Cloudflare: a 15-year Origin CA cert obtained via Cloudflare's API
  - CloudFront: an LE cert that CloudFront accepts as origin verification
- **No ACME rate limits to worry about** for the CDN-managed providers. Cloudflare Origin CA is instant and unmetered.

In CDN mode the user-facing TLS is the CDN's responsibility, including the first-visit experience for new hostnames. Our box serves traffic to the CDN over HTTPS using the origin cert.

## Requirements

- Linux with systemd (Ubuntu 20+, Debian 11+, RHEL/CentOS Stream 8+, Fedora 36+, Amazon Linux 2023, Alpine 3.16+)
- One of: nginx 1.18+ OR Apache httpd 2.4+
- Node.js 18 or newer
- A public IP (or be behind a load balancer / CDN that forwards traffic to you)
- For Let's Encrypt: port 80 reachable from the internet (HTTP-01 validation)
- For Cloudflare: a Cloudflare API token with "Origin CA" scope
- For CloudFront: AWS credentials with CloudFront permissions

## Installation

```bash
# Clone or extract this repo
cd /tmp/Autohost

# Install. Detects engine (nginx vs Apache), distro, paths automatically.
sudo bash install.sh

# Or with options
sudo bash install.sh --engine nginx --provider letsencrypt --contact admin@example.com
sudo bash install.sh --engine apache --provider cloudflare
```

The installer:

- Detects your distro (Debian/Ubuntu/RHEL/Fedora/Alpine/Amazon Linux)
- Detects your engine (nginx vs Apache; installs nginx if neither is present)
- Installs Node.js and openssl if missing
- Creates an `Autohost` system user, adds them to your web server's group
- Copies source to `/opt/Autohost/`
- Installs systemd units (`Autohost.service`, `Autohost-renew.timer`)
- Generates a 10-year bootstrap self-signed cert (`/etc/Autohost/bootstrap.crt`) for the HTTPS catch-all default_server. This cert is only seen by users who type `https://` against an unprovisioned hostname — they get the standard browser warning and a "use HTTP for setup" message. To rotate it: delete the `bootstrap.crt`/`bootstrap.key` files and re-run `install.sh`, which is idempotent and will regenerate them.
- Installs the splash HTML to `/etc/Autohost/splash.html` (HTTP) and `/etc/Autohost/splash-https.html` (HTTPS fallback)
- Installs the per-host vhost template to `/etc/Autohost/vhost-template.conf` (only if it doesn't already exist; the latest version always goes to `vhost-template.conf.example` for reference)
- Validates the web server config (`nginx -t` / `apachectl configtest`)

Two ready-to-use config files live in the `examples/` directory:

- `examples/config-letsencrypt.json` — direct LE with rate limits, multi-resolver DNS, all tunables
- `examples/config-cloudflare.json` — Cloudflare Origin CA, higher rate limits since no ACME involved

Copy whichever fits your deployment to `/etc/Autohost/config.json` and edit.

After install:

```bash
# Review config
sudo vi /etc/Autohost/config.json

# (Optional) customize the splash
sudo vi /etc/Autohost/splash.html

# (Optional) customize what generated per-host vhosts look like
sudo vi /etc/Autohost/vhost-template.conf

# Start
sudo systemctl start Autohost
sudo systemctl reload nginx        # or apache2 / httpd

# Watch
sudo journalctl -u Autohost -f
```

## Configuration

Three layers, priority order: env vars → `/etc/Autohost/config.json` → built-in defaults.

### Core settings

Configuration is layered: env var beats `/etc/Autohost/config.json` beats built-in default. The config file path itself can be overridden with `Autohost_CONFIG=/path/to/file.json` — useful for testing, containerized deployments, or per-tenant operator setups.

**Headline settings** (most deployments only touch these):

| Setting | Env var | Default | What it does |
|---|---|---|---|
| Engine | `Autohost_ENGINE` | (auto-detect) | `nginx` or `apache` |
| Provider | `Autohost_PROVIDER` | `letsencrypt` | Cert provider |
| Proxy target | `Autohost_PROXY_TARGET` | `127.0.0.1:3000` | Where customer traffic is proxied to |
| Contact email | `Autohost_ACME_CONTACT_EMAIL` | (none) | Let's Encrypt contact email |
| ACME staging | `Autohost_ACME_STAGING` | `false` | Use LE staging for testing (no rate limits, not browser-trusted) |
| Vhost template | `Autohost_VHOST_TEMPLATE_PATH` | `/etc/Autohost/vhost-template.conf` | Operator-editable per-host vhost template |
| Our public IPs | `Autohost_OUR_IPS` (comma-separated) | (auto-detect) | Override IP discovery |
| Log level | `Autohost_LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

**HSTS** is not a config option — it's opt-in via the vhost template only. Add the `Strict-Transport-Security` header to your `/etc/Autohost/vhost-template.conf` after your fleet's TLS is stable. See the [HSTS behavior](#hsts-behavior) section for why this is template-driven and not a flag.

**The splash HTML path** is not a config option either — the nginx/Apache catch-all references `/etc/Autohost/splash.html` directly. To move or rename the splash file, edit `/etc/nginx/conf.d/Autohost.conf` (or the Apache equivalent) and adjust the `alias` directive.

**Operational tunables** (rarely changed):

| Setting | Env var | Default | What it does |
|---|---|---|---|
| Reload debounce | `Autohost_RELOAD_DEBOUNCE_MS` | `2000` | Coalesce reload-storms within this window |
| Per-IP rate limit | `Autohost_PER_IP_LIMIT_PER_HOUR` | `10` | Cap provisions per source IP per hour |
| Global rate limit | `Autohost_GLOBAL_LIMIT_PER_HOUR` | `100` | Cap total provisions per hour box-wide |
| Socket path | `Autohost_SOCKET_PATH` | `/run/Autohost/Autohost.sock` | Where web server posts to Autohost |
| Vhost dir | `Autohost_VHOST_DIR` | engine default | Where per-host configs are written |
| Cert dir | `Autohost_CERT_DIR` | engine default | Where per-host certs are written |
| ACME challenges root | `Autohost_ACME_CHALLENGES_ROOT` | `/var/lib/Autohost` | Shared dir for HTTP-01 tokens |
| nginx binary | `Autohost_NGINX_BINARY` | (auto-detect) | Path to `nginx` |
| Apache binary | `Autohost_APACHE_BINARY` | (auto-detect) | Path to `apachectl` |

For negative-cache TTLs (`dnsMismatchCacheMs`, `certFailCacheMs`) and other deeper tunables, edit `/etc/Autohost/config.json` directly. See the worked examples in `examples/config-letsencrypt.json` and `examples/config-cloudflare.json`.

### Per-provider settings

**Cloudflare** (Origin CA cert for behind-Cloudflare deployments):
```bash
export Autohost_CLOUDFLARE_API_TOKEN=cf_xxxxxxxxxx
export Autohost_CLOUDFLARE_CERT_VALIDITY_DAYS=5475   # optional, default 15 years
```
Set `"provider": "cloudflare"` in config.json.

The Cloudflare provider uses the [Origin CA API](https://developers.cloudflare.com/api/operations/origin-ca-create-certificate) to issue an origin cert. The customer's domain must be in Cloudflare with the proxy enabled.

**CloudFront SaaS Manager:**
```bash
export Autohost_AWS_REGION=us-east-1
export Autohost_AWS_ACCESS_KEY_ID=...
export Autohost_AWS_SECRET_ACCESS_KEY=...
export Autohost_CLOUDFRONT_DISTRIBUTION_ID=E1A2B3C4D5E6F7
```
Set `"provider": "cloudfront"` in config.json.

Current implementation issues an LE cert for the origin and emits a warning about CloudFront-side alias registration being a TODO. For production, register hostnames with the CloudFront distribution out-of-band (manually or via separate automation).

## File layout

```
/opt/Autohost/                        # source files (read-only after install)
├── src/
│   ├── Autohost.js                   # main service (Unix socket handler)
│   ├── config.js                      # config loader + auto-detection
│   ├── dnsCheck.js                    # multi-resolver DNS query
│   ├── templates.js                   # template loader + {{placeholder}} substitution
│   ├── logger.js
│   ├── rateLimit.js
│   ├── renew.js                       # cert renewal pass (run from systemd timer)
│   ├── engines/
│   │   ├── nginx.js
│   │   └── apache.js
│   ├── providers/
│   │   ├── letsencrypt.js
│   │   ├── cloudflare.js
│   │   ├── cloudfront.js
│   │   └── none.js
│   └── static/
│       ├── splash.html                # HTTP-first design surface
│       └── splash-https.html          # minimal HTTPS-fallback
├── scripts/
│   └── Autohost-trigger.sh           # Apache CGI helper
├── node_modules/
└── package.json

/etc/Autohost/                        # config + splash (editable)
├── config.json
├── splash.html                        # served on HTTP catch-all
├── splash-https.html                  # served on HTTPS catch-all (fallback)
├── vhost-template.conf                # per-host vhost template (operator-editable)
├── vhost-template.conf.example        # latest version shipped (for reference)
├── bootstrap.crt                      # self-signed cert for HTTPS catch-all
├── bootstrap.key
├── sites/                             # (Apache only) per-host vhosts
└── certs/                             # (Apache only) per-host certs

/etc/nginx/conf.d/                     # (nginx only)
├── Autohost.conf                     # catch-all + ACME + includes
├── auto/                              # per-host vhosts
└── auto-certs/                        # per-host certs

/etc/apache2/conf-enabled/             # (Apache, Debian)
└── Autohost.conf

/etc/httpd/conf.d/                     # (Apache, RHEL)
└── Autohost.conf

/var/lib/Autohost/                    # runtime state
├── acme-account.key                   # LE account key
└── .well-known/acme-challenge/        # ACME tokens (shared across hosts)

/run/Autohost/
└── Autohost.sock                     # Unix socket for the trigger

/etc/systemd/system/
├── Autohost.service
├── Autohost-renew.service
└── Autohost-renew.timer              # daily cert renewal
```

## Operational characteristics

### Zero-downtime reloads

Both `nginx -s reload` and `apachectl graceful` are graceful reloads. The master process re-reads config and spawns new workers with the new config; old workers finish in-flight requests and exit. **No connection is ever dropped.**

Reloads are debounced with a 2-second window and mutex-guarded. A burst of 50 vhosts installed in one minute → 2-3 reloads, not 50.

### Config validation before reload

Before every reload, Autohost runs the engine's config-test command (`nginx -t` / `apachectl configtest`). If the test fails, the reload is **skipped** and the failure is logged. The web server keeps running on the previous (working) config. No silent breakage.

### HSTS behavior

HSTS (`Strict-Transport-Security`) is **off by default** everywhere — not on the catch-all, not on per-host vhosts. This is deliberate. Setting HSTS on a freshly-provisioned hostname locks browsers into HTTPS for a year. Combined with the unavoidable first-visit cert situation for unprovisioned hostnames, that locks legitimate users out of the HTTP-first onboarding flow Autohost relies on.

The intended flow is: customer points DNS at your server → first visit hits HTTP cleanly → splash → provisioning runs → page refreshes → real cert serves the customer's app. No browser warnings anywhere in that path because HSTS isn't forcing HTTPS-first attempts.

Operators who want HSTS can add it to their custom vhost template at `/etc/Autohost/vhost-template.conf` after their fleet's TLS setup is proven stable. The line to add is simply:

```nginx
add_header Strict-Transport-Security "max-age=31536000" always;
```

### Rate limiting

Two sliding-window rate limits (default 1-hour windows):

- **Per-source-IP**: 10 provisions/hour per client IP (configurable via `perIpLimitPerHour`)
- **Global**: 100 provisions/hour box-wide (configurable via `globalLimitPerHour`)

Both protect upstream provider quotas. Let's Encrypt has a 50-cert-per-week per-registered-domain limit and a 5-failed-validation-per-hour per-account limit; the Autohost rate limiter should fire before LE's does.

### Authorization hook (optional)

By default Autohost provisions any host that passes the DNS-points-at-us check (or, in CDN mode, any host the CDN forwards). That's the right behavior for a single-tenant box or a trusted environment. For multi-tenant platforms — where you want to control *which* customer or project may attach *which* domain — Autohost exposes an optional authorization hook.

Set `authorizeHook` to the path of a Node module:

```json
{ "authorizeHook": "/etc/autohost/authorize-hook.js" }
```

or via `AUTOVHOST_AUTHORIZE_HOOK=/etc/autohost/authorize-hook.js`. The module exports a function (or `{ authorize }`) with the signature:

```js
async authorize(host, context) -> { allowed: boolean, reason?, code?, meta? }
//   host    : requested hostname (already format-validated)
//   context : { requestIp, headers, provider, isCdnMode }
```

The hook runs **after** the DNS/CDN check proves the host points at this box and after the rate limit, but **before** any cert is provisioned — so it gates the expensive ACME work. Use it for an allowlist, a single-use domain-bound token, a per-project quota, or a call into your own control plane.

Safety properties, which matter because this sits on the path to cert issuance:

- Anything other than `{ allowed: true }` is a **deny**.
- A hook that **throws fails closed** — a control-plane outage denies provisioning rather than opening it to everyone.
- A configured-but-unloadable hook is a **hard startup failure** by default (`authorizeHookRequired: true`), so a broken authorizer can never silently disappear and leave provisioning wide open.
- A denied host is **not** negative-cached — authorization can change (quota frees up, a token is minted) without the host being permanently "bad".

A worked example, including a single-use, short-expiry, **domain-bound** token pattern (bind the token to the one host it authorizes so a leaked token can't be spent on a different domain, and send it as a header, never a query string, so it doesn't land in access logs), is in [`examples/authorize-hook.example.js`](examples/authorize-hook.example.js).

### Negative caching

- **DNS mismatch**: 5 minutes by default. Short because the customer may be propagating DNS right now. Tune via `dnsMismatchCacheMs` in config.json.
- **Cert failure**: 1 hour by default. Longer because retrying immediately just hits the same upstream error and burns Let's Encrypt rate limits. Tune via `certFailCacheMs` in config.json.

### DNS multi-resolver

The DNS check queries the system resolver plus 1.1.1.1 and 8.8.8.8 in parallel. Any positive match across resolvers is accepted. This handles propagation lag where the cloud-provider resolver hasn't refreshed but a public resolver has. Configurable via `dnsResolvers` in config.json.

### Public IP discovery

Autohost needs to know its own public IPs to verify customer DNS points at it. When `ourIps` isn't set explicitly (the recommended approach for production), Autohost cascades through these sources in order:

1. **AWS IMDSv2** at `169.254.169.254` (token-authenticated)
2. **Azure IMDS** at `169.254.169.254` (with `Metadata: true` header)
3. **GCP metadata** at `metadata.google.internal`
4. **Public echo services** as last resort: `api.ipify.org`, `icanhazip.com`, `ifconfig.me`

The cloud metadata endpoints are link-local and require no outbound internet. The public echo services do make outbound HTTPS calls, which may be undesirable in privacy-sensitive or air-gapped environments. To skip auto-discovery entirely, set `ourIps` explicitly in config.json or via `Autohost_OUR_IPS=1.2.3.4,5.6.7.8`. Discovered IPs are cached for 5 minutes by default.

### Cert renewal

A systemd timer (`Autohost-renew.timer`) runs daily at 03:17 with up to 1h of randomized delay. For each cert expiring within 30 days, it re-runs the provider's renewal flow, atomically replaces the cert files, and reloads the web server (via the configured engine, so Apache deployments reload Apache, nginx reloads nginx).

To trigger a renewal pass manually for testing or emergency cert refresh:

```bash
sudo systemctl start Autohost-renew.service   # run once via systemd
# or
sudo -u Autohost node /opt/Autohost/src/renew.js   # run directly
```

The renewal log goes to journald: `journalctl -u Autohost-renew`.

## Customization

### Per-host vhost template (the big one)

The most important customization point. Autohost generates each per-host vhost from a template file you can edit freely. The template lives at `/etc/Autohost/vhost-template.conf` after installation. Edit it, restart Autohost (`systemctl restart Autohost`), and new provisions use your customized template. Existing provisioned vhosts stay as-is until they're regenerated.

The template uses `{{placeholder}}` syntax. Available placeholders:

| Placeholder | Value |
|---|---|
| `{{hostname}}` | Customer hostname being provisioned, e.g. `app.example.com` |
| `{{certPath}}` | Full path to the per-host cert file |
| `{{keyPath}}` | Full path to the per-host key file |
| `{{proxyTarget}}` | Value from `config.proxyTarget`, e.g. `127.0.0.1:3000` |
| `{{acmeChallengesRoot}}` | Shared ACME tokens dir (for renewal HTTP-01 validation) |

Multiple occurrences of the same placeholder are all replaced. Unknown placeholders are left alone — so nginx `$variable` and Apache `%{VAR}` syntax passes through untouched.

**Edits don't apply until restart.** Templates are read once at startup and cached for the life of the process. After editing `/etc/Autohost/vhost-template.conf`, run `sudo systemctl restart Autohost` to pick up the new template. Already-provisioned vhosts retain whatever template was active when they were provisioned — to regenerate one, delete its file in the auto vhosts directory and let it re-provision on next traffic.

**Example: per-hostname static files with proxy fallback (nginx):**

```nginx
server {
    listen 443 ssl http2;
    server_name {{hostname}};
    ssl_certificate     {{certPath}};
    ssl_certificate_key {{keyPath}};

    root /var/www/{{hostname}};

    location / {
        try_files $uri $uri/ @app;
    }
    location @app {
        proxy_pass http://{{proxyTarget}};
    }
}
```

**Example: different upstreams per path (nginx):**

```nginx
server {
    listen 443 ssl http2;
    server_name {{hostname}};
    ssl_certificate     {{certPath}};
    ssl_certificate_key {{keyPath}};

    location /api/  { proxy_pass http://api-backend:8080; }
    location /ws/   { proxy_pass http://ws-backend:8081; proxy_set_header Upgrade $http_upgrade; }
    location /     { proxy_pass http://{{proxyTarget}}; }
}
```

**Example: per-hostname document root for static sites (Apache):**

```apache
<VirtualHost *:443>
    ServerName {{hostname}}
    DocumentRoot /srv/sites/{{hostname}}
    SSLEngine on
    SSLCertificateFile      {{certPath}}
    SSLCertificateKeyFile   {{keyPath}}
    <Directory "/srv/sites/{{hostname}}">
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
```

The install script ships a reasonable default template that proxies everything to `{{proxyTarget}}`. The installer never overwrites your edited template — upgrades drop a fresh copy at `/etc/Autohost/vhost-template.conf.example` so you can see what changed.

If the template file is missing or unreadable, Autohost falls back to a built-in default template hardcoded in the engine. So the project works out-of-the-box without any template file at all.

### Splash page

The splash served while provisioning lives at `/etc/Autohost/splash.html`. Edit it freely. It must be a self-contained HTML file (no external scripts, stylesheets, or images — those wouldn't load reliably during first-visit because there's no real cert yet).

### Provider customization

The provider interface is `{ name, provisionCert(host) → {cert, key}, renewCert(host) → {cert, key} }`. To add a new provider (e.g., for a custom internal CA), create `src/providers/yourprovider.js` exporting `create(cfg) → providerObject` and register it in `Autohost.js`'s `providerModules` map.

## Examples

### Basic Let's Encrypt setup

```bash
sudo bash install.sh --provider letsencrypt --contact admin@example.com
sudo systemctl start Autohost
sudo systemctl reload nginx
```

Point `app.example.com` at your server's IP. Visit `https://app.example.com`. First hit: splash + browser warning. Refresh after ~15 seconds: real LE cert, working site.

### Behind Cloudflare

```bash
sudo bash install.sh --provider cloudflare
echo 'Autohost_CLOUDFLARE_API_TOKEN=cf_xxxxxxxxxx' | sudo tee /etc/Autohost/environment
sudo systemctl edit Autohost.service   # add: EnvironmentFile=/etc/Autohost/environment
sudo systemctl daemon-reload
sudo systemctl restart Autohost
```

Customer adds their domain to Cloudflare with proxy enabled, points DNS at your server's IP. First visit hits Cloudflare → Cloudflare connects to your origin → Autohost fetches Origin CA cert + installs vhost → reload. Subsequent visits get Cloudflare's edge cert (universal SSL) for browser TLS.

### Apache deployment

```bash
sudo bash install.sh --engine apache --provider letsencrypt --contact admin@example.com
sudo systemctl start Autohost
sudo systemctl reload apache2   # or httpd
```

Same flow as nginx but the engine writes Apache VirtualHost configs.

### Testing without burning ACME quota

```bash
sudo bash install.sh --provider none
sudo systemctl start Autohost
```

Self-signed certs for everything. Browsers warn but the full flow is testable.

Or use Let's Encrypt staging (no rate limits, not browser-trusted):

```json
{ "provider": "letsencrypt", "acmeStaging": true }
```

## Security model

Autohost runs as a dedicated unprivileged `Autohost` system user. systemd hardening: `NoNewPrivileges`, `ProtectHome`, `ProtectKernelTunables`, `RestrictAddressFamilies`, `MemoryMax=256M`.

Paths are scoped:
- Read-only: `/etc/Autohost/` (config + bootstrap cert + splash)
- Read-write: `/var/lib/Autohost/`, the engine's vhost/cert dirs, `/run/Autohost/`

The hostname validator is strict (RFC 1123-ish: ≤63 chars per label, ≤253 total, no underscores, no leading/trailing hyphens, alphanumeric + hyphen + dot only). The vhost config generators only interpolate the hostname into the config; no shell metacharacters are possible.

Web server reloads use `execFile` with array argv — no shell interpretation.

HSTS is not set anywhere by default — not on the catch-all, not on per-host vhosts. The catch-all has the standard reason (HSTS on a catch-all would poison browser state for hostnames the operator doesn't control). Per-host HSTS is opt-in via the operator's custom vhost template only after their TLS setup is proven stable. See [HSTS behavior](#hsts-behavior) for the full rationale.

## Testing

```bash
npm test
```

Or directly:

```bash
bash test/run-tests.sh
```

Current count: **167 tests across 11 files.**

- `testUnit.js` — pure function tests (hostname validation, vhost generation, rate limit math, both engines)
- `testEngines.js` — nginx and Apache engine output, validateConfig/reload interfaces
- `testTemplates.js` — template loader: `{{placeholder}}` substitution, file loading, caching, fallback to engine default, HSTS opt-in via custom template
- `testProviders.js` — provider interface tests (none provider end-to-end, Cloudflare CSR generation)
- `testDnsCheck.js` — multi-resolver behavior
- `testHandler.js` — Unix socket HTTP endpoint
- `testReload.js` — debounce, mutex, config-test pre-flight, post-reload retry
- `testRenew.js` — cert expiry parsing, engine-routed renewal reload
- `testCdnMode.js` — CDN-mode DNS-check bypass for cloudflare/cloudfront
- `testSplash.js` — both splash HTML files (HTTP + HTTPS-fallback) structural validation

Real ACME calls are not made during tests. To test against real Let's Encrypt, set `acmeStaging: true` and provision a test hostname manually.

## Limitations

- **No DNS-01 challenge support.** HTTP-01 only. No wildcard certs.
- **No multi-host instances.** Each Autohost runs on one box. Fleet deployments provision certs independently per box. Central cert state with replication is a separate problem.
- **CloudFront provider is partial.** Origin cert works (via LE); CloudFront-side alias registration via AWS SDK is a TODO.
- **No web UI.** Configuration via JSON file and env vars. Status via journalctl.
- **First HTTPS visit always shows a browser warning** for an unprovisioned hostname. Unavoidable for any direct-TLS architecture; only solvable by putting a CDN in front.

## FAQ

**Does `nginx -s reload` / `apachectl graceful` cause downtime?**

No. Both are graceful reloads. Master re-reads config, spawns new workers with new config, old workers finish in-flight requests and exit. No connection dropped. The same mechanism is in nginx since the early 2000s and Apache since 1.3.

**What does the user see on first visit?**

Over HTTP: the splash, immediately, no warning. Auto-refreshes. After ~30 seconds the refresh lands on the real vhost.

Over HTTPS to an unprovisioned hostname: TLS handshake with the bootstrap self-signed cert and a browser warning. Click-through serves a minimal "HTTPS not ready — try HTTP for setup" page. This is rare in practice because real first-visit traffic typically lands on HTTP first, then once provisioning completes the per-host vhost is the one serving HTTPS with a real cert.

**Why isn't HSTS on by default?**

HSTS on a freshly-provisioned hostname locks browsers into HTTPS for that hostname for a year. Combined with the unavoidable cert situation for unprovisioned hostnames, that breaks the clean HTTP-first onboarding Autohost relies on — customers re-visiting after their cert expires or after we move hosts would get stuck on the self-signed bootstrap warning instead of falling back to HTTP. HSTS is opt-in via the operator's custom `/etc/Autohost/vhost-template.conf` and should only be enabled once your TLS setup is stable across your fleet.

**Can I run this without systemd?**

The Node service is just `node /opt/Autohost/src/Autohost.js`. Use whatever process supervisor you want (OpenRC, supervisord, runit, Docker, etc.). For renewal, cron works fine: `0 3 * * * Autohost node /opt/Autohost/src/renew.js`.

**How do I trigger a renewal pass manually?**

`sudo systemctl start Autohost-renew.service` to run a single pass via systemd, or `sudo -u Autohost node /opt/Autohost/src/renew.js` to run directly. The renewal job checks every cert in the cert directory and renews any with less than 30 days remaining. Logs go to `journalctl -u Autohost-renew`.

**What happens if DNS is propagating during the first visit?**

The multi-resolver check queries system + 1.1.1.1 + 8.8.8.8 in parallel. Any positive match → proceeds. The negative cache for DNS mismatches is only 5 minutes by default (tunable via `dnsMismatchCacheMs`), so customers who hit during propagation succeed quickly on retry.

**Can I use this for non-customer-facing hostnames?**

Yes. Autohost is agnostic about customer/tenant semantics. Use it for staging domains, dev branches, internal admin tools, anything that resolves to your box.

**Does this work with HTTP/3 / QUIC?**

If your nginx is built with HTTP/3 support, add `listen 443 quic reuseport;` to `/etc/Autohost/vhost-template.conf` and restart Autohost. Cert provisioning is unaffected.

**What's the X-Forwarded-By / behind-CDN behavior?**

When provider is `cloudflare` or `cloudfront`, Autohost runs in CDN mode: DNS check is skipped because the CDN already validated the hostname, and the cert is for the CDN→origin leg rather than browser-facing. This makes provisioning effectively instant — no ACME, no public DNS lookups.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

High-value additions:

- DNS-01 challenge support for wildcard certs (with per-provider DNS API integration)
- AWS CloudFront SaaS Manager alias registration (the SDK call that's currently TODO)
- Additional cert providers: BuyPass Go SSL, ZeroSSL, custom internal CAs
- Tests with real LE staging
- Docker / Kubernetes deployment manifests
- i18n for the splash page

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgments

Built originally as a component of the [Safebox](https://safebots.org) attested-cloud platform; extracted as a standalone tool because the design generalizes cleanly.

Dependencies:
- [acme-client](https://github.com/publishlab/node-acme-client) — clean and well-maintained Node ACME library
- [node-forge](https://github.com/digitalbazaar/forge) — pure-JS crypto for CSR generation
