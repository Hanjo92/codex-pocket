# codex-pocket

A lightweight browser-based viewer/controller for Codex sessions.

## Goal

See and lightly control a running Codex session from another browser without mirroring the whole desktop.

## Scope

- **Host:** a desktop machine running Codex with access to its local state under `~/.codex`
- **Client:** any modern browser
- **Priority:** mobile-friendly UX first, but not limited to iPhone

> The current prototype was built and tested mainly on macOS, but the UI itself is just a local web app that can be opened from any browser/device that can reach it.

## Current capabilities

- Read recent Codex threads from local Codex state
- Pick a specific thread from the browser UI
- Search/filter/sort threads by title, source, and project label
- View transcripts in a mobile-friendly, collapsible format
- Show a cleaner browser-facing thread/session model without exposing host absolute paths in normal API payloads
- Send text input into the selected thread
- Interrupt the active turn
- Send quick terminal controls when Codex exposes a live stdin target:
  - Enter
  - Escape
  - Ctrl+C
- Optional local-user browser login with a cookie-based session
- Local account/process CLI for repeatable setup and launch
- Local user-management CLI for adding/removing browser login users on the host machine

## Current prototype

- `npm start`
- or `npm run run` via the local account-aware CLI
- serves on `http://localhost:4782`
- reads recent Codex threads from `~/.codex/state_5.sqlite`
- parses linked rollout JSONL files for transcript display
- uses the Codex app-server bridge for input, interrupt, and terminal control
- supports a login-screen + HTTP-only cookie auth flow when one or more local users exist in `run/users.json`
- works in any browser, with extra care for narrow/mobile screens

## Quick start

1. Run Codex on the host machine you want to inspect/control.
2. In this project, start the local companion server:

   ```bash
   npm start
   ```

   Or use the local account-aware CLI:

   ```bash
   npm run onboard
   npm run run
   ```

   Safer defaults in the current prototype:
   - bind host: `127.0.0.1`
   - browser port: `4782`
   - Codex app-server listen URL: `ws://127.0.0.1:4791`

   Optional hardening/runtime override env vars:

   ```bash
   CODEX_POCKET_HOST=127.0.0.1
   ```

   To enable browser login, create a local user on the host machine:

   ```bash
   npm run user:add -- <username>
   ```

3. Open the UI from a browser:
   - same machine: `http://localhost:4782`
   - another device on the same network/VPN: `http://<host-address>:4782`
4. If local browser users are configured, sign in through the browser login screen with that username/password.
5. Pick a thread from the list.
6. Read the transcript, send input, interrupt, or use quick terminal controls when available.

## Quick mental model

`codex-pocket` has two sides:

1. **Host machine**
   - runs Codex
   - has access to `~/.codex`
   - runs the `codex-pocket` Node server
2. **Client device**
   - opens the `codex-pocket` web UI in a browser
   - can be a phone, tablet, laptop, or another desktop

The client never talks to Codex app-server directly. It only talks to the `codex-pocket` web server.

## Remote access

`codex-pocket` does not depend on Tailscale specifically.

Any setup that lets a browser reach the host machine on the app port can work, for example:

- the same machine via `localhost`
- another device on the same LAN
- a VPN-connected device (including Tailscale, WireGuard, ZeroTier, or a company VPN)
- a reverse-proxied/private internal route

Important detail:

- the browser only needs access to the `codex-pocket` web server port
- the Codex app-server itself can stay bound to `127.0.0.1` on the host, because `codex-pocket` talks to it locally
- in the current prototype, the browser-facing port is `4782` by default
- by default the web server now binds to `127.0.0.1`, so LAN/VPN exposure requires an explicit host override

In other words: remote browser access can be generalized as "any trusted network path to the host web UI," not "Tailscale only."

## Example access patterns

### 1. Same machine

- run `npm start`
- open `http://localhost:4782`

### 2. Another device on the same LAN

- run `codex-pocket` on the host desktop
- find the host's LAN address
- open `http://<host-lan-ip>:4782` from another browser on the same network

### 3. Remote device over VPN

- connect the client device to the same private network as the host
- open `http://<host-vpn-ip>:4782`
- this can be Tailscale, WireGuard, ZeroTier, or another VPN path

## Practical setup notes

- `codex-pocket` should run on the same machine as the Codex state you want to inspect/control
- the host machine needs local access to `~/.codex`
- the browser only needs HTTP reachability to the `codex-pocket` port
- if you expose this beyond localhost, prefer a trusted private network or an authenticated private route
- the current prototype is optimized for trusted personal/internal use, not hardened public internet exposure

## Local process/account commands

The project now includes a small local CLI for repeatable setup, account switching, and preflight checks.

### Run the current/default account

```bash
npm run run
```

### First-time onboarding

```bash
npm run onboard
```

This creates a local config under `run/accounts.json` (gitignored) and stores:
- bind host
- browser port
- `CODEX_HOME`
- Codex app-server listen URL
- Codex app-server URL

Browser login users are stored separately in `run/users.json` (also gitignored).

### Add another account

```bash
npm run account:add -- <account-name>
```

### Remove an account

```bash
npm run account:remove -- <account-name>
```

### List configured accounts

```bash
npm run account:list
```

### Show one account's details

```bash
npm run account:show -- <account-name>
```

### Change the default account

```bash
npm run account:set-default -- <account-name>
```

### Add a browser login user

```bash
npm run user:add -- <username>
```

Passwords are stored as local password hashes in `run/users.json`, not as plain text.

### List browser login users

```bash
npm run user:list
```

### Remove a browser login user

```bash
npm run user:remove -- <username>
```

### Rotate a browser login password

```bash
npm run user:set-password -- <username>
```

### Print the effective env for an account

```bash
npm run print-env -- <account-name>
```

### Run a quick preflight check

```bash
npm run doctor -- <account-name>
```

This checks things like:
- `CODEX_HOME` presence
- `state_5.sqlite` presence
- Codex app-server reachability
- bind host / browser port
- whether any local browser login users are configured

## Architecture

### Host side

- Codex stores thread/session data under `~/.codex`
- a small local companion service handles:
  - recent thread discovery
  - rollout/transcript parsing
  - browser API endpoints
  - event-driven session updates
  - input/control forwarding to Codex app-server

### Client side

Phase 1:
- responsive web app / PWA-like flow
- compact thread picker
- transcript reader
- input bar + quick controls

Phase 2:
- optional native wrapper/app
- saved hosts/sessions
- reconnect logic
- stronger auth and session management

## Project structure

- `docs/architecture.md` — system design notes
- `docs/mvp-plan.md` — practical build order
- `docs/next-steps.md` — current UX and feature follow-ups

## Current limitations

- The current implementation is built around Codex state under `~/.codex`.
- Read-side transcript rendering still depends on rollout/state parsing rather than a fully semantic Codex thread model.
- Some controls, like Enter / Esc / Ctrl+C, only work when Codex exposes a live terminal stdin target for that thread.
- The UI is mobile-friendly, but still a prototype rather than a polished production app.
- Authentication/access control is not yet hardened for public internet exposure.

## Security notes

- Prefer `localhost`, LAN, VPN, or another trusted private route.
- Do **not** expose this prototype directly to the public internet without adding proper auth and transport protections.
- Keep the Codex app-server bound locally when possible; `codex-pocket` can proxy browser interactions to it.
- The safer default bind host is `127.0.0.1`; use `CODEX_POCKET_HOST=0.0.0.0` or another explicit address only when you intentionally want remote reachability.
- Create at least one local browser login user before opening access beyond localhost. The browser UI uses a login screen and stores the authenticated session in an HTTP-only cookie.
- Browser login users are created locally on the Codex host via the CLI; they are not self-service from the web UI.
- Browser-facing API payloads are intentionally reduced so normal thread/session reads do not expose host absolute paths like `cwd` or rollout file locations.
- Anyone who can reach the web UI and satisfy auth may be able to inspect transcripts and send control/input actions, so treat network exposure carefully.

## Recommendation

Keep the browser-based version as the default surface first. If it proves useful, wrap it later as a native mobile app instead of treating iPhone as the only target from day one.
