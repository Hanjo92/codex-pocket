# Immediate next steps

## What the current prototype already does

- serves a browser-based Codex viewer/controller UI
- reads recent Codex thread metadata from `~/.codex/state_5.sqlite`
- parses linked rollout JSONL transcripts
- lists recent Codex threads and lets you switch between them
- supports text input, interrupt, and conditional terminal quick controls
- uses event-driven session refresh instead of constant session polling

## How to try it

1. Make sure Codex has been used on the host machine.
2. Start this project:
   - `npm start`
3. Open the UI:
   - local machine: `http://localhost:4782`
   - another trusted device: `http://<host-address>:4782`
4. If local browser users are configured, sign in with that username/password when the browser login screen appears.

## Current limitations

- read-side transcript rendering is still based on rollout/state parsing rather than a richer semantic thread model
- terminal quick controls only work when Codex exposes a live terminal stdin target for the selected thread
- auth/access now includes roles, modes, visibility scope, and a much better manager UX, but it is still intentionally lightweight rather than a hardened public-internet auth system
- the UI is mobile-friendly but still clearly prototype-grade

## Next implementation targets

1. improve transcript modeling beyond rollout parsing
2. make terminal-interaction state surface faster/more reliably in the UI
3. go beyond the new internal-sharing hardening baseline with stronger auth/session/audit controls if broader self-hosted exposure is needed
4. add stronger filtering or richer list organization if the thread list grows further
5. polish delegated read-only/restricted review flows with stronger context cues where needed
6. consider multi-host views as the next oversight layer
