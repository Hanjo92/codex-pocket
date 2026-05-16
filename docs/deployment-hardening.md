# Deployment hardening notes

`codex-pocket` is still designed first for localhost, LAN, VPN, or other trusted private routes.
This guide is about making that internal sharing safer — not about claiming public-internet readiness.

## Recommended exposure order

1. `localhost` only
2. trusted LAN
3. VPN / Tailscale / reverse proxy on a private network
4. anything broader only after adding stronger auth/TLS/ops controls outside this repo

## Baseline checklist

- keep the Codex app-server bound locally
- create at least one browser login user before exposing beyond localhost
- prefer `read_only` / `input_only` users for shared viewers
- narrow access with `projectPrefixes`, `threadIds`, and optional `actionThreadIds`
- terminate TLS at a reverse proxy if traffic leaves the host
- avoid exposing the raw Node server directly to the public internet

## New server hardening knobs

### `CODEX_POCKET_ALLOWED_ORIGINS`

Comma-separated browser origins allowed to make `POST` requests.
This helps reduce cross-site request risk for cookie-authenticated sessions.

Example:

```bash
export CODEX_POCKET_ALLOWED_ORIGINS="https://codex-pocket.example.com,https://pocket.internal"
```

Notes:
- requests without an `Origin` header are still allowed (useful for local scripts / curl)
- `GET` reads are unchanged
- blocked writes return `403 {"error":"Origin not allowed"}`

### `CODEX_POCKET_FORCE_SECURE_COOKIES`

Force the auth cookie to carry the `Secure` flag even when HTTPS is terminated by a proxy that does not forward `x-forwarded-proto`.

```bash
export CODEX_POCKET_FORCE_SECURE_COOKIES=true
```

Use this when:
- the browser reaches the site over HTTPS
- a reverse proxy sits in front of `codex-pocket`
- you want to avoid accidentally issuing non-secure cookies because proxy headers are incomplete

## Reverse proxy notes

If you place `codex-pocket` behind Caddy, Nginx, or another proxy:

- keep upstream traffic on a trusted machine/network
- forward the original `Host` header
- forward `X-Forwarded-Proto: https` when TLS terminates at the proxy
- restrict who can reach the proxy endpoint
- consider adding IP allowlists or VPN-only access there too

## Suggested internal-sharing pattern

### Reviewer account

```bash
npm run user:add -- reviewer
npm run user:set-mode -- reviewer read_only
npm run user:set-projects -- reviewer /Users/song/Projects/codex-pocket
```

### Narrow interactive helper account

```bash
npm run user:add -- helper
npm run user:set-mode -- helper input_only
npm run user:set-projects -- helper /Users/song/Projects/codex-pocket
npm run user:set-action-threads -- helper <thread-id-1,thread-id-2>
```

This keeps the helper able to send follow-up text only on explicitly allowed threads while other visible threads remain read-only.

## Still not solved here

These changes improve internal deployment posture, but they do **not** make the app a hardened internet-facing service.
Still missing for that bar:

- stronger auth/session design
- better auditability / logging
- rate limiting / abuse controls
- fuller CSRF / proxy / cookie deployment story
- secret management and production ops guidance
- more formal multi-user threat modeling
