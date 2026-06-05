#!/bin/bash
#
# install.sh — install autohost on a Linux system.
#
# Auto-detects:
#   - Linux distro (Debian/Ubuntu/RHEL/Fedora/Amazon Linux/Alpine)
#   - Web server engine (nginx vs Apache; uses whichever is installed)
#   - nginx/Apache user
#   - Node.js version (installs if missing)
#
# Idempotent. Re-running upgrades source files but doesn't break existing
# state, certs, or vhosts.
#
# Usage:
#   sudo bash install.sh                                   # detect everything
#   sudo bash install.sh --engine nginx                    # force nginx
#   sudo bash install.sh --engine apache                   # force Apache
#   sudo bash install.sh --provider letsencrypt --contact admin@example.com
#   sudo bash install.sh --provider cloudflare             # behind Cloudflare
#
# After install:
#   - Edit /etc/autohost/config.json or set AUTOVHOST_* env vars
#   - For Cloudflare: set AUTOVHOST_CLOUDFLARE_API_TOKEN
#   - For CloudFront: set AUTOVHOST_AWS_* env vars
#   - systemctl restart autohost && systemctl reload <nginx|apache2|httpd>

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: install must run as root (use sudo)" >&2
    exit 1
fi

SRC_DIR="${SRC_DIR:-$(cd "$(dirname "$0")" && pwd)}"
INSTALL_DIR=/opt/autohost
PROVIDER=letsencrypt
ENGINE=""
CONTACT_EMAIL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --provider)      PROVIDER="$2"; shift 2 ;;
        --engine)        ENGINE="$2"; shift 2 ;;
        --contact)       CONTACT_EMAIL="$2"; shift 2 ;;
        --src-dir)       SRC_DIR="$2"; shift 2 ;;
        --install-dir)   INSTALL_DIR="$2"; shift 2 ;;
        -h|--help)       sed -n '3,30p' "$0"; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

# ── Distro detection ─────────────────────────────────────────────────────────
if command -v dnf >/dev/null 2>&1; then PKG_MGR=dnf
elif command -v apt-get >/dev/null 2>&1; then PKG_MGR=apt; export DEBIAN_FRONTEND=noninteractive
elif command -v apk >/dev/null 2>&1; then PKG_MGR=apk
elif command -v yum >/dev/null 2>&1; then PKG_MGR=yum
else echo "ERROR: unsupported distro" >&2; exit 1; fi
echo "▶ Package manager: $PKG_MGR"

# ── Engine detection ─────────────────────────────────────────────────────────
if [[ -z "$ENGINE" ]]; then
    if command -v nginx >/dev/null 2>&1; then
        ENGINE=nginx
    elif command -v apachectl >/dev/null 2>&1 || command -v apache2ctl >/dev/null 2>&1; then
        ENGINE=apache
    else
        ENGINE=nginx  # default to nginx; install it below
    fi
fi
echo "▶ Engine: $ENGINE"

# ── Install dependencies ─────────────────────────────────────────────────────
install_packages() {
    local extras=()
    if [[ "$ENGINE" == "nginx" ]]; then extras+=(nginx)
    elif [[ "$ENGINE" == "apache" ]]; then
        case "$PKG_MGR" in
            apt) extras+=(apache2) ;;
            dnf|yum) extras+=(httpd mod_ssl) ;;
            apk) extras+=(apache2 apache2-ssl apache2-proxy apache2-utils) ;;
        esac
    fi

    case "$PKG_MGR" in
        apt) apt-get update -q; apt-get install -y -q openssl ca-certificates curl "${extras[@]}" ;;
        dnf|yum) $PKG_MGR install -y -q openssl ca-certificates curl "${extras[@]}" ;;
        apk) apk add --no-cache openssl ca-certificates curl "${extras[@]}" ;;
    esac
}

ensure_node() {
    if node --version 2>/dev/null | grep -qE 'v(1[89]|[2-9][0-9])\.'; then return; fi
    echo "▶ Installing Node.js (>=18)..."
    case "$PKG_MGR" in
        apt) curl -fsSL https://deb.nodesource.com/setup_18.x | bash - >/dev/null; apt-get install -y -q nodejs ;;
        dnf|yum) curl -fsSL https://rpm.nodesource.com/setup_18.x | bash - >/dev/null; $PKG_MGR install -y -q nodejs ;;
        apk) apk add --no-cache nodejs npm ;;
    esac
}

echo "▶ Installing system dependencies..."
install_packages
ensure_node
echo "  node:  $(node --version)"

# ── Engine-specific user detection ───────────────────────────────────────────
WEB_USER=""
if [[ "$ENGINE" == "nginx" ]]; then
    for u in nginx www-data; do
        if id "$u" >/dev/null 2>&1; then WEB_USER="$u"; break; fi
    done
    [[ -z "$WEB_USER" ]] && WEB_USER=nginx
else
    for u in www-data apache httpd; do
        if id "$u" >/dev/null 2>&1; then WEB_USER="$u"; break; fi
    done
    [[ -z "$WEB_USER" ]] && WEB_USER=www-data
fi
echo "  web user: $WEB_USER"

# ── Create autohost user ────────────────────────────────────────────────────
if ! id autohost >/dev/null 2>&1; then
    echo "▶ Creating autohost user..."
    useradd --system --no-create-home --shell /usr/sbin/nologin autohost \
        || adduser -S -H -s /sbin/nologin autohost
fi

# Add autohost to the web server's group so it can write vhost configs
# that nginx/apache reads.
usermod -a -G "$WEB_USER" autohost 2>/dev/null || true

# ── Install source ───────────────────────────────────────────────────────────
echo "▶ Installing source to $INSTALL_DIR..."
install -d -m 0755 /opt
install -d -m 0755 "$INSTALL_DIR" "$INSTALL_DIR/src" "$INSTALL_DIR/src/providers" \
    "$INSTALL_DIR/src/engines" "$INSTALL_DIR/src/static" "$INSTALL_DIR/scripts"

for f in autohost.js config.js dnsCheck.js logger.js rateLimit.js renew.js; do
    install -m 0644 "$SRC_DIR/src/$f" "$INSTALL_DIR/src/$f"
done
for f in letsencrypt.js cloudflare.js cloudfront.js none.js; do
    install -m 0644 "$SRC_DIR/src/providers/$f" "$INSTALL_DIR/src/providers/$f"
done
for f in nginx.js apache.js; do
    install -m 0644 "$SRC_DIR/src/engines/$f" "$INSTALL_DIR/src/engines/$f"
done
install -m 0644 "$SRC_DIR/src/static/splash.html" "$INSTALL_DIR/src/static/splash.html"
install -m 0644 "$SRC_DIR/package.json" "$INSTALL_DIR/package.json"

# Apache CGI helper
if [[ "$ENGINE" == "apache" ]]; then
    install -m 0755 "$SRC_DIR/apache-templates/autohost-trigger.sh" \
        "$INSTALL_DIR/scripts/autohost-trigger.sh"
fi

# ── npm install ──────────────────────────────────────────────────────────────
echo "▶ Installing npm dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev --no-audit --no-fund --no-package-lock >/dev/null
chown -R root:root "$INSTALL_DIR/node_modules"

# ── Runtime directories ──────────────────────────────────────────────────────
install -d -m 0750 -o autohost -g autohost /var/lib/autohost
install -d -m 0755 -o autohost -g autohost /var/lib/autohost/.well-known
install -d -m 0755 -o autohost -g autohost /var/lib/autohost/.well-known/acme-challenge
install -d -m 0755 -o autohost -g autohost /run/autohost
chmod o+x /var/lib/autohost  # web server needs to traverse to challenges

install -d -m 0755 /etc/autohost

# Engine-specific vhost + cert dirs
if [[ "$ENGINE" == "nginx" ]]; then
    install -d -m 0755 /etc/nginx/conf.d/auto
    install -d -m 0750 -o autohost -g "$WEB_USER" /etc/nginx/conf.d/auto-certs
    chmod o+x /etc/nginx/conf.d/auto-certs
else
    install -d -m 0755 /etc/autohost/sites
    install -d -m 0750 -o autohost -g "$WEB_USER" /etc/autohost/certs
    chmod o+x /etc/autohost/certs
fi

# ── Install splash HTML into /etc/autohost ──────────────────────────────────
# splash.html       — beautiful HTTP-first landing page (the design surface)
# splash-https.html — minimal HTTPS-fallback ("use HTTP for setup")
install -m 0644 "$SRC_DIR/src/static/splash.html"       /etc/autohost/splash.html
install -m 0644 "$SRC_DIR/src/static/splash-https.html" /etc/autohost/splash-https.html

# ── Install per-host vhost template ──────────────────────────────────────────
# This is the template autohost substitutes for each provisioned hostname.
# Operators edit this file to customize the generated per-host vhosts:
# location blocks, try_files directives, per-hostname doc roots, custom
# headers, WAF rules, anything nginx/Apache config can express.
#
# We always ship the latest version as vhost-template.conf.example so
# operators can see what new placeholders are supported. We only install
# vhost-template.conf if it doesn't already exist — operator customizations
# survive upgrades.
if [[ "$ENGINE" == "nginx" ]]; then
    TEMPLATE_SRC="$SRC_DIR/nginx-templates/vhost-template.conf"
else
    TEMPLATE_SRC="$SRC_DIR/apache-templates/vhost-template.conf"
fi
install -m 0644 "$TEMPLATE_SRC" /etc/autohost/vhost-template.conf.example
if [[ ! -f /etc/autohost/vhost-template.conf ]]; then
    install -m 0644 "$TEMPLATE_SRC" /etc/autohost/vhost-template.conf
    echo "▶ Installed vhost template at /etc/autohost/vhost-template.conf"
else
    echo "▶ Preserved existing /etc/autohost/vhost-template.conf (new version at .example)"
fi

# ── Config file ──────────────────────────────────────────────────────────────
if [[ ! -f /etc/autohost/config.json ]]; then
    echo "▶ Writing default config..."
    cat > /etc/autohost/config.json <<EOF
{
  "engine": "$ENGINE",
  "provider": "$PROVIDER",
  "acmeContactEmail": "$CONTACT_EMAIL",
  "acmeStaging": false,
  "hsts": true,
  "proxyTarget": "127.0.0.1:3000",
  "logLevel": "info"
}
EOF
    chmod 0640 /etc/autohost/config.json
    chown root:autohost /etc/autohost/config.json
fi

# ── Engine template ──────────────────────────────────────────────────────────
echo "▶ Installing web server config..."
if [[ "$ENGINE" == "nginx" ]]; then
    install -m 0644 "$SRC_DIR/nginx-templates/autohost.conf" \
        /etc/nginx/conf.d/autohost.conf
elif [[ "$ENGINE" == "apache" ]]; then
    # Apache conf.d differs by distro
    if [[ -d /etc/apache2/conf-available ]]; then
        install -m 0644 "$SRC_DIR/apache-templates/autohost.conf" \
            /etc/apache2/conf-available/autohost.conf
        ln -sf /etc/apache2/conf-available/autohost.conf /etc/apache2/conf-enabled/autohost.conf 2>/dev/null || true
        # Make sure required modules are enabled (Debian-ism)
        a2enmod ssl rewrite headers proxy proxy_http cgi alias 2>/dev/null || true
    elif [[ -d /etc/httpd/conf.d ]]; then
        install -m 0644 "$SRC_DIR/apache-templates/autohost.conf" \
            /etc/httpd/conf.d/autohost.conf
    else
        echo "WARNING: could not locate Apache conf.d; placing in /etc/autohost/apache-include.conf" >&2
        install -m 0644 "$SRC_DIR/apache-templates/autohost.conf" \
            /etc/autohost/apache-include.conf
        echo "You must manually add: Include /etc/autohost/apache-include.conf to your Apache config"
    fi
fi

# ── Bootstrap self-signed cert ───────────────────────────────────────────────
if [[ ! -f /etc/autohost/bootstrap.crt ]]; then
    echo "▶ Generating bootstrap self-signed cert..."
    openssl req -x509 -newkey rsa:2048 \
        -keyout /etc/autohost/bootstrap.key \
        -out /etc/autohost/bootstrap.crt \
        -days 3650 -nodes \
        -subj '/CN=autohost-bootstrap' >/dev/null 2>&1
    chmod 0644 /etc/autohost/bootstrap.crt
    chmod 0640 /etc/autohost/bootstrap.key
    chown root:"$WEB_USER" /etc/autohost/bootstrap.key
fi

# ── systemd units ────────────────────────────────────────────────────────────
echo "▶ Installing systemd units..."
install -m 0644 "$SRC_DIR/units/autohost.service" /etc/systemd/system/autohost.service
install -m 0644 "$SRC_DIR/units/autohost-renew.service" /etc/systemd/system/autohost-renew.service
install -m 0644 "$SRC_DIR/units/autohost-renew.timer" /etc/systemd/system/autohost-renew.timer
systemctl daemon-reload
systemctl enable autohost.service autohost-renew.timer

# ── Validate config ──────────────────────────────────────────────────────────
if [[ "$ENGINE" == "nginx" ]]; then
    if ! nginx -t >/dev/null 2>&1; then
        echo "WARNING: nginx -t failed after install" >&2
        nginx -t || true
    fi
else
    APACHE_BIN=$(command -v apachectl || command -v apache2ctl)
    if ! $APACHE_BIN configtest >/dev/null 2>&1; then
        echo "WARNING: Apache configtest failed after install" >&2
        $APACHE_BIN configtest || true
    fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  autohost installed"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Engine:   $ENGINE"
echo "  Provider: $PROVIDER"
echo ""
echo "  Next steps:"
echo "    1. Review /etc/autohost/config.json"
echo "    2. Edit /etc/autohost/splash.html if you want to customize the page"
echo "    3. Start the service:"
echo "         systemctl start autohost"
if [[ "$ENGINE" == "nginx" ]]; then
    echo "         systemctl reload nginx"
else
    if command -v apache2 >/dev/null; then
        echo "         systemctl reload apache2"
    else
        echo "         systemctl reload httpd"
    fi
fi
echo "    4. Point a domain at this server's public IP"
echo "    5. Visit https://<your-domain> — first hit provisions cert + vhost"
echo ""
echo "  Logs: journalctl -u autohost -f"
echo ""
