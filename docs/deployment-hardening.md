# Deployment hardening notes

`codex-pocket` is designed first for localhost, LAN, VPN, or other trusted private routes.
This guide is about making that internal sharing safer — not about claiming public-internet readiness.

## Intended safety envelope

The current target is:

- one Codex host
- a small number of trusted devices / trusted people
- localhost, LAN, VPN, or a private reverse-proxied route

The current target is **not**:

- broad delegated reviewer access
- self-serve internet-facing collaboration
- a hardened public SaaS-style security model

That product boundary is intentional. `codex-pocket` is a low-noise browser dashboard for trusted internal sharing, not a general remote-access platform.

## Recommended exposure order

1. `localhost` only
2. trusted LAN
3. VPN / Tailscale / reverse proxy on a private network
4. anything broader only after adding stronger auth/TLS/ops controls outside this repo

## When the current model is enough

The current auth/session model is usually good enough when all of these are true:

- the browser route is only reachable on a trusted private network
- you control the devices or people receiving access
- you create browser users locally on the host
- you use scoped accounts (`read_only`, `input_only`, limited thread/project visibility) for shared viewers
- you can revoke access by changing local users, roles, scope, or active sessions

## When the current model is **not** enough

Do **not** treat the current model as sufficient when you need any of the following:

- direct public-internet exposure
- self-service account creation or password recovery
- strong protection against credential stuffing or abuse
- enterprise-style audit/export/compliance needs
- formal tenant isolation or untrusted-user collaboration
- high-confidence protections against malicious reverse-proxy / cookie / browser deployment mistakes

If you need that level, `codex-pocket` should sit behind additional controls outside this repo or wait for a future product slice.

## Baseline checklist

- keep the Codex app-server bound locally
- create at least one browser login user before exposing beyond localhost
- prefer `read_only` / `input_only` users for shared viewers
- narrow access with `projectPrefixes`, `threadIds`, and optional `actionThreadIds`
- terminate TLS at a reverse proxy if traffic leaves the host
- avoid exposing the raw Node server directly to the public internet
- prefer private reachability to one browser port instead of broader host exposure

## Recommended safer defaults

These are the defaults or near-defaults worth preserving for shared/internal deployments:

```bash
# Prefer local bind unless you intentionally need direct LAN reachability.
export CODEX_POCKET_HOST=127.0.0.1

# Keep Codex app-server local-only.
export CODEX_POCKET_APP_SERVER_LISTEN=ws://127.0.0.1:4791
export CODEX_POCKET_APP_SERVER_URL=ws://127.0.0.1:4791

# If browser traffic reaches codex-pocket over HTTPS through a proxy,
# keep cookies marked Secure even when proxy headers are imperfect.
export CODEX_POCKET_FORCE_SECURE_COOKIES=true

# Limit cookie-authenticated writes to your known browser origins.
export CODEX_POCKET_ALLOWED_ORIGINS="https://codex-pocket.example.com,https://pocket.internal"

# Optional: shorten session lifetime for shared deployments.
export CODEX_POCKET_SESSION_TTL_SECONDS=$((60 * 60 * 24 * 7))
```

Notes:

- `CODEX_POCKET_HOST=127.0.0.1` is the safest default; only change it when you intentionally want direct network reachability
- if you use a reverse proxy, prefer leaving `codex-pocket` bound locally and exposing the proxy instead
- shorter `CODEX_POCKET_SESSION_TTL_SECONDS` values can reduce the blast radius of stale shared sessions, but they are not a substitute for stronger auth

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
- prefer proxy -> `127.0.0.1:4782` rather than opening the Node server broadly
- forward the original `Host` header
- forward `X-Forwarded-Proto: https` when TLS terminates at the proxy
- restrict who can reach the proxy endpoint
- consider adding IP allowlists or VPN-only access there too
- keep TLS policy, auth gateways, and access logging at the proxy layer when possible

## Pre-exposure checklist

Before giving anyone access beyond localhost, confirm:

- [ ] browser login users exist
- [ ] shared viewers are using lower-risk roles/modes where possible
- [ ] project/thread/action scope is narrowed where appropriate
- [ ] the browser route is private (LAN/VPN/private proxy), not generally public
- [ ] TLS terminates before traffic leaves a trusted machine/network
- [ ] `CODEX_POCKET_ALLOWED_ORIGINS` is set when using cookie-authenticated browser sessions across real origins
- [ ] `CODEX_POCKET_FORCE_SECURE_COOKIES=true` is enabled behind HTTPS reverse proxies if header forwarding is uncertain
- [ ] you know how to revoke active sessions if a device should lose access

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

- stronger auth/session design beyond the current trusted-internal-sharing baseline
- better auditability / logging / export story
- rate limiting / abuse controls
- fuller CSRF / proxy / cookie deployment story
- secret management and production ops guidance
- more formal multi-user threat modeling
- clearer internet-facing gateway patterns if broader exposure ever becomes a goal
