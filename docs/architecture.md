# Architecture

## Product idea

A focused browser surface for Codex sessions.

Instead of full remote desktop, the client sees a Codex-aware thread picker, transcript view, and a small set of targeted controls.

## Why this approach

- easier to read in a browser than full desktop mirroring
- lighter bandwidth and lower friction
- safer to scope than exposing a whole desktop session
- easier to add Codex-specific controls later

## Core components

### 1. Session host

A desktop machine running Codex with local access to `~/.codex`.

Responsibilities:
- keep Codex available locally
- expose local state and rollout files to the companion service
- optionally run the local Codex app-server bridge

### 2. Companion server

A small local Node service (`codex-pocket`) running on the same host as the Codex state.

Responsibilities:
- discover recent threads from local Codex state
- read transcript/rollout data from `.codex`
- expose browser-facing HTTP APIs
- watch for session changes and publish event-driven updates
- forward input, interrupt, and terminal-control requests to the Codex app-server
- optionally require shared-token auth for browser/API access

### 3. Browser client

Initial form: responsive web app.
Later form: optional native wrapper or dedicated app.

Responsibilities:
- connect to the companion server
- render thread lists and transcripts clearly on small screens
- send small inputs and quick actions
- show connection/session state
- cache lightweight client-side UI state such as selected thread and filters

## Communication model

### Read path

- browser calls the companion server over HTTP
- server reads local Codex thread metadata from `state_5.sqlite`
- server reads rollout JSONL files for transcript content
- browser subscribes to session update events and refreshes only when the selected thread changes

### Write/control path

- browser sends text input or control actions to the companion server
- server validates/parses the request
- server talks to the local Codex app-server
- Codex app-server handles:
  - `turn/start`
  - `turn/interrupt`
  - terminal stdin writes when a live terminal interaction target exists

## Current security baseline

Current baseline in the prototype:
- browser server binds to `127.0.0.1` by default
- optional shared token via `CODEX_POCKET_AUTH_TOKEN`
- no need to expose the Codex app-server directly to remote clients
- prefer LAN/VPN/private routes over public exposure

Still missing / future hardening:
- stronger auth/session management
- clearer multi-user separation
- optional read-only mode
- tighter auditability for control inputs

## Open questions

- Should transcript rendering stay rollout-based, or move to richer semantic thread modeling?
- Should approval prompts get special button treatment?
- Is a native wrapper worth it, or is the web UI enough?
- What level of auth is appropriate for broader sharing beyond personal/private use?

## Recommended build path

1. browser-based Codex state viewer/controller
2. stronger auth and safer remote access patterns
3. richer Codex-aware transcript/turn modeling
4. optional native app wrapper if the workflow proves sticky
