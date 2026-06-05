// src/rateLimit.js
//
// Two rate limits, both sliding-window with 1-hour windows:
//   - per-source-IP: caps how many provisions we do from any single client IP
//   - global: caps total provisions per hour box-wide
//
// Both protect against accidental or intentional abuse exhausting ACME or
// CDN-provider rate limits.

'use strict';

const config = require('./config');
const cfg = config.load();

// timestamp arrays per IP
const perIpWindows = new Map();
const globalWindow = [];

const WINDOW_MS = 60 * 60 * 1000;

function pruneWindow(arr) {
    const cutoff = Date.now() - WINDOW_MS;
    while (arr.length > 0 && arr[0] < cutoff) arr.shift();
}

function allowPerIp(ip) {
    if (!ip) return true;  // no caller IP → can't rate-limit
    let arr = perIpWindows.get(ip);
    if (!arr) { arr = []; perIpWindows.set(ip, arr); }
    pruneWindow(arr);
    if (arr.length >= cfg.perIpLimitPerHour) return false;
    arr.push(Date.now());
    return true;
}

function allowGlobal() {
    pruneWindow(globalWindow);
    if (globalWindow.length >= cfg.globalLimitPerHour) return false;
    globalWindow.push(Date.now());
    return true;
}

// Periodic cleanup of stale per-IP entries
setInterval(() => {
    for (const [ip, arr] of perIpWindows) {
        pruneWindow(arr);
        if (arr.length === 0) perIpWindows.delete(ip);
    }
}, 5 * 60 * 1000).unref();

module.exports = {
    allowPerIp,
    allowGlobal,
    _reset: () => { perIpWindows.clear(); globalWindow.length = 0; },
    _state: () => ({ perIp: perIpWindows.size, global: globalWindow.length }),
};
