#!/bin/bash
# /opt/autohost/scripts/autohost-trigger.sh
#
# CGI helper called by Apache to trigger autohost provisioning. Apache
# doesn't have a built-in "mirror" directive like nginx, so we invoke this
# script via mod_rewrite + ScriptAlias, then immediately return the splash.
#
# This script:
#   1. Reads the requested host from QUERY_STRING (set by mod_rewrite)
#   2. Reads the client IP from REMOTE_ADDR
#   3. POSTs to the autohost Unix socket (fire-and-forget)
#   4. Returns an HTTP response that redirects internally to the splash
#
# The actual provisioning happens asynchronously on the Node side.

# Parse host from QUERY_STRING (format: 'host=<value>')
HOST=""
if [[ "$QUERY_STRING" =~ host=([^&]+) ]]; then
    HOST="${BASH_REMATCH[1]}"
fi

# Validate hostname format defensively (autohost will validate too, but
# this prevents shell injection if QUERY_STRING is malformed somehow)
if [[ ! "$HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || [[ ${#HOST} -gt 253 ]]; then
    HOST=""
fi

CLIENT_IP="${REMOTE_ADDR:-}"

# Fire the trigger in the background; don't wait
if [[ -n "$HOST" ]] && [[ -S /run/autohost/autohost.sock ]]; then
    BODY=$(printf '{"host":"%s","requestIp":"%s"}' "$HOST" "$CLIENT_IP")
    (
        curl --unix-socket /run/autohost/autohost.sock \
             -X POST -H 'Content-Type: application/json' \
             -d "$BODY" \
             --max-time 5 \
             http://localhost/provision \
             >/dev/null 2>&1
    ) &
fi

# Return the splash HTML directly. We can't easily do an internal redirect
# from CGI in Apache; sending the content inline is simpler.
echo "Status: 200 OK"
echo "Content-Type: text/html"
echo "Cache-Control: no-store, no-cache, must-revalidate"
echo ""
cat /etc/autohost/splash.html 2>/dev/null || cat <<EOF
<!doctype html>
<html><head><title>Provisioning - Safebox</title>
<meta http-equiv="refresh" content="10"></head>
<body style="background:#1f1f24;color:#e8e6e0;font-family:system-ui;padding:40px;">
<h1>Provisioning HTTPS certificates</h1>
<p>Check back in a minute or two. This page refreshes automatically.</p>
</body></html>
EOF
