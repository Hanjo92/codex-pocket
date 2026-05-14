# MVP plan

## Phase 0 — validate the shape

Goal: confirm that a Codex-aware browser surface is enough.

- verify recent threads can be discovered from local Codex state
- verify rollout/transcript parsing is usable for reading
- verify small input forwarding works reliably through Codex app-server
- verify interrupt and simple terminal controls cover the common cases

## Phase 1 — thin web prototype

Goal: usable browser access with minimal build cost.

Build:
- small local Node server
- thread list + transcript view
- mobile-friendly web UI
- text input + Enter/Esc/Ctrl+C buttons when available
- lightweight auth for trusted private use

Success criteria:
- can read recent Codex session/thread activity from another browser
- can send short inputs
- can interrupt an active turn
- can recover after temporary disconnect

## Phase 2 — quality pass

- better transcript grouping and readability
- reconnect/session resume improvements
- auth hardening
- one-tap install / wrapper-friendly UX
- stronger thread/project navigation

## Phase 3 — native app decision

Move to a native wrapper or dedicated app only if at least one of these matters:
- much better readability/interaction is needed
- background behavior matters
- notifications matter
- multiple hosts/sessions need richer UX

## Suggested next technical spikes

### Option A: richer semantic thread modeling
- cleaner user/assistant turn extraction
- better transcript summaries
- safer/higher-quality UI decisions

### Option B: stronger deployment/auth model
- better remote access story
- clearer self-hosting guidance
- more confidence before public exposure

## Recommendation

Keep the browser-first approach, then invest next in stronger transcript modeling and security/deployment hardening before expanding scope further.
