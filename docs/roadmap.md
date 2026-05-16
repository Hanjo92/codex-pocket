# Roadmap

## Positioning

OpenAI's official Codex remote/mobile flow is becoming the default way to remotely control a Codex host.

That means `codex-pocket` should lean harder into a different shape:

> a focused browser dashboard for triaging, reading, and lightly steering many Codex threads

Not "remote desktop for Codex," but "the best low-noise control tower for Codex work."

## Versioning note

`v1.0.0` was the first public release/tag for opening the repository.

From here, planned product increments move in **+0.1.0 minor steps**:

- `1.1.0`
- `1.2.0`
- `1.3.0`
- ...

## 1.1.0 — attention and triage

Theme: make it obvious what needs attention right now.

Planned work:

- thread/session state classification
  - `running`
  - `waiting_input`
  - `waiting_approval`
  - `completed`
  - `failed`
- inbox/attention view for high-signal items
- filters for actionable vs informational activity
- stronger project-level rollups

Why it matters:

The official remote experience can handle direct control. `codex-pocket` should help users scan many threads quickly and decide where to jump in.

## 1.2.0 — distilled reading

Theme: reduce transcript noise.

Planned work:

- concise per-thread summaries
- "what changed since last check" summaries
- surfaced failure reasons and blockers
- clearer separation between final answer, tool noise, and hidden intermediate details

Why it matters:

A browser dashboard wins when it is easier to read than the raw host/client experience.

## 1.3.0 — safer scoped control

Theme: let users expose `codex-pocket` more safely on trusted networks.

Shipped foundation so far:

- permission modes:
  - read-only
  - input-only
  - control-enabled
- role boundaries:
  - owner
  - admin
  - member
- optional per-account visibility scope:
  - allowed project prefixes
  - allowed thread ids
- clearer UI indicators for allowed actions and restricted onboarding
- server-side enforcement for thread/session reads plus input/control endpoints
- browser-side scope management polish:
  - chip-based scope editing
  - human-readable thread selection
  - real path-prefix project presets
  - inline save feedback in the permission manager
- narrower session-level interaction boundaries:
  - optional per-user action-thread allowlist
  - visible-but-read-only session fallback outside that allowlist

Remaining work in this area:

- decide whether `1.3.0` stops at safe internal sharing or grows into a fuller delegation model
- if broader sharing is needed later, add stronger auth/session/audit controls beyond the current internal-use baseline

Why it matters:

A lighter browser surface becomes more useful when it can be safely shared without giving full control by default.

## Backlog after 1.3.0

Possible follow-ons:

- better multi-host support
- stronger deployment hardening guidance beyond the current internal-sharing checklist/origin guard baseline

## Current product lens

If the official app is best at **remote control**, `codex-pocket` should aim to be best at:

- **triage**
- **readability**
- **multi-thread oversight**
- **low-noise browser access**
- **safer limited exposure**
