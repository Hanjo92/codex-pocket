# Immediate next steps

## What this scaffold does

- serves a tiny mobile-friendly web page
- reads the latest Codex thread metadata from `~/.codex/state_5.sqlite`
- parses the linked rollout JSONL transcript
- shows recent Codex activity in Safari on iPhone
- lists recent Codex threads and lets you switch between them

## How to try it

1. Make sure Codex desktop or CLI has been used on this Mac
2. Start this project:
   - `cd /Users/song/Projects/codex-pocket`
   - `npm start`
3. Open on the Mac first:
   - `http://localhost:4782`
4. On the same network, try the Mac IP from iPhone Safari too

## Current limitations

- polling only, no WebSocket live streaming yet
- no authentication yet
- terminal quick controls are wired, but only activate when Codex exposes a live terminal stdin target for the current thread
- app-server write path currently targets local Codex on this Mac only

## Next implementation targets

1. add WebSocket live updates
2. make terminal-interaction state surface faster/more reliably in the UI
3. add Tailscale or token auth
4. add thread pinning/favorites or stronger filtering if the list grows
