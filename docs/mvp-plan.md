# MVP plan

## Phase 0 — validate the shape

Goal: confirm that a tmux-backed mobile view is enough.

- run Codex in a named `tmux` session
- verify output can be captured cleanly
- verify small input forwarding works reliably
- check whether Codex UI needs full terminal emulation

## Phase 1 — thin web prototype

Goal: usable phone access with minimal build cost.

Build:
- small server on the Mac (Node or Python)
- WebSocket output stream
- mobile-friendly web UI
- text input + Enter/Esc/Ctrl+C buttons
- optional read-only mode

Success criteria:
- can read the active Codex session on iPhone
- can send short inputs
- can recover after temporary disconnect

## Phase 2 — quality pass

- better terminal rendering
- reconnect/session resume
- auth hardening
- one-tap home-screen install
- quick action buttons for common flows

## Phase 3 — native app decision

Move to SwiftUI only if at least one of these matters:
- much better readability/interaction needed
- background behavior matters
- notifications matter
- multiple hosts/sessions need richer UX

## Suggested first technical spike

Compare these two approaches:

### Option A: tmux capture + custom renderer
- simpler
- more app-specific control
- may break on richer terminal behavior

### Option B: existing web terminal stack
- xterm.js or similar
- more faithful terminal rendering
- slightly heavier but safer for TUI behavior

## My recommendation

Start with Option B for the prototype unless the Codex output is mostly plain text.
