# codex-pocket

A lightweight mobile viewer/controller for a Codex CLI session running on a Mac.

## Goal

See and lightly control a running Codex client from iPhone without mirroring the whole desktop.

## MVP

- Read the latest Codex desktop/CLI session from local Codex state on macOS
- Expose the session through a small local companion service
- Show the latest transcript/output on iPhone over HTTP first
- Add focused controls later:
  - refresh/live stream
  - text input
  - Enter
  - Escape
  - Ctrl+C
  - simple approve/confirm actions

## Proposed architecture

### macOS side

- Codex stores thread/session data under `~/.codex`
- companion service manages:
  - latest thread discovery from local Codex state
  - rollout/transcript parsing
  - output streaming
  - later input forwarding
  - authentication gate

### iPhone side

Phase 1:
- mobile web app / PWA
- terminal-like read view
- compact input bar
- quick action buttons

Phase 2:
- dedicated SwiftUI app
- saved hosts/sessions
- reconnect logic
- better typography and controls

## Project structure

- `docs/architecture.md` — system design notes
- `docs/mvp-plan.md` — practical build order

## Next recommendation

Start with a web-based MVP first, then wrap or rebuild as a native iPhone app if it proves useful.

## Current prototype

- `npm start`
- opens on `http://localhost:4782`
- reads recent Codex threads from `~/.codex/state_5.sqlite`
- lets you pick a specific thread from the mobile UI
- supports client-side search/filter for thread title, path, and source
- uses a tighter responsive layout for narrow iPhone screens
- parses the linked rollout JSONL file and renders recent entries in a mobile-friendly page
