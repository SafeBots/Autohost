// src/logger.js
//
// Tiny structured logger. Writes JSON lines to stderr (captured by systemd
// or stderr redirect). Level filtering at error|warn|info|debug.

'use strict';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function create(name, levelStr) {
    const threshold = LEVELS[levelStr] !== undefined ? LEVELS[levelStr] : LEVELS.info;
    function log(level, event, fields) {
        if (LEVELS[level] > threshold) return;
        const entry = Object.assign({ ts: new Date().toISOString(), level, name, event }, fields || {});
        try { process.stderr.write(JSON.stringify(entry) + '\n'); } catch {}
    }
    return {
        error: (event, fields) => log('error', event, fields),
        warn:  (event, fields) => log('warn',  event, fields),
        info:  (event, fields) => log('info',  event, fields),
        debug: (event, fields) => log('debug', event, fields),
    };
}

module.exports = { create, LEVELS };
