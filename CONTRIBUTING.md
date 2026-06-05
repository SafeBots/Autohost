# Contributing to autohost

Thanks for your interest. autohost is intentionally small and focused, so we're careful about adding features that expand the surface area.

## What we want

- **Bug fixes** — always welcome
- **DNS-01 challenge support** for wildcard certs (with at least one DNS provider, e.g. Cloudflare DNS or Route53)
- **CloudFront SaaS Manager alias registration** (the AWS SDK call that's currently TODO in `src/providers/cloudfront.js`)
- **Additional cert providers** for legitimate use cases: BuyPass Go SSL, ZeroSSL, custom internal CAs
- **Operational improvements**: better metrics, log format options, status endpoint
- **Documentation improvements**: clearer examples, deployment guides for specific stacks

## What we don't want (probably)

- **Heavy frameworks.** autohost is plain Node + ~2 npm deps. Keep it small.
- **Caddy-style auto-discovery for everything.** We deliberately do DNS check then ACME, not auto-resolution.
- **Web UIs.** Out of scope. Add a sidecar if you want one.
- **Migrations between providers at runtime.** Pick one provider per box; if you need to switch, restart with new config.

## Process

1. Open an issue first for anything non-trivial. We'll discuss the design before code.
2. Tests required for new behavior. See `test/` for patterns.
3. No `console.log` in source — use the logger.
4. Match existing code style (4-space indent, single quotes, strict mode, no transpilation).
5. The hostname validator is security-critical. Changes there need extra-careful review.

## Running tests

```bash
npm test
```

Tests must pass before merging. If a test is flaky, fix it; don't skip it.

## Security

For security issues, please email security@safebots.org rather than opening a public issue.
