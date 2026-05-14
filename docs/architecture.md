# Architecture

## Product idea

A focused remote surface for Codex sessions.

Instead of remote desktop, the phone sees only the active Codex terminal session and can send limited input.

## Why this approach

- easier to read on a phone than full desktop mirroring
- lighter bandwidth and lower friction
- safer to scope than exposing a whole desktop
- easier to add Codex-specific controls later

## Core components

### 1. Session host

Codex runs inside `tmux` on the Mac so the session survives disconnects.

Responsibilities:
- keep session alive
- allow reattach locally
- provide a stable capture target

### 2. Companion server

Small local service on the Mac.

Responsibilities:
- inspect active tmux session(s)
- capture current screen/state
- stream incremental output
- forward selected input to tmux
- authenticate remote client
- optionally restrict access to local network or Tailscale

### 3. Mobile client

Initial form: PWA.
Later form: native iOS app.

Responsibilities:
- connect to server
- render terminal output clearly on small screens
- send small inputs and quick actions
- show connection/session state

## Communication model

### Read path

- mobile connects to companion server
- server sends initial terminal snapshot
- server pushes incremental updates via WebSocket

### Write path

- mobile sends keystrokes or text commands
- server validates/normalizes input
- server forwards input into `tmux send-keys` or PTY write

## Security baseline

Minimum acceptable baseline:
- no public unauthenticated exposure
- prefer Tailscale or LAN-only access first
- token-based auth for client
- optional session read-only mode
- audit log for control inputs if needed later

## Open questions

- Is full-screen terminal fidelity required, or is line-oriented rendering enough?
- Does Codex rely on a rich TUI that needs full VT100 emulation?
- Should approval prompts get special button treatment?
- Is native push notification for waiting states valuable later?

## Recommended build path

1. `tmux`-based prototype
2. browser/PWA viewer
3. Codex-aware controls
4. native iOS app if the workflow sticks
