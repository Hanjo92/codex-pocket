# State classification design

## Purpose

Define a conservative first-pass normalized state model for `codex-pocket` triage.

This document is the implementation/design companion for:
- #1 Add thread/session state classification for triage
- #6 Define normalized state derivation rules for Codex threads
- #7 Expose normalized thread state in APIs and live updates
- #8 Show normalized state badges in list and thread UI

## Design principles

1. **Prefer conservative classification**
   If signals are unclear, do not pretend to know more than we do.

2. **Optimize for triage, not perfect ontology**
   The goal is to help the user decide where to look next.

3. **Keep the first version small**
   Use a simple state set and evolve later.

## Normalized states

### `running`
A turn appears to be actively in progress.

### `waiting_input`
The thread looks idle, but the likely next action is user follow-up or new instruction.

### `waiting_approval`
The thread appears blocked on a user approval or confirmation step.

### `completed`
The thread appears idle and not obviously blocked; the most recent assistant activity looks like a completed response.

### `failed`
The thread appears to have hit an error, explicit failure, or unrecovered blocked condition.

### `unknown`
Fallback when signals are too weak or conflicting.

## Likely signal sources in the current prototype

Current code has access to:

- local SQLite thread metadata from `state_5.sqlite`
- rollout JSONL transcript entries
- app-server terminal interaction notifications
- app-server thread/turn reads for active runtime control flows

That means the first implementation should combine:

- recent transcript block types/content
- current active turn presence
- terminal interaction availability
- any explicit runtime status if already available cheaply

## Recommended derivation approach

Use ordered rules from strongest signal to weakest signal.

### Rule order

1. explicit failure/error signal -> `failed`
2. explicit approval-needed signal -> `waiting_approval`
3. active in-progress turn signal -> `running`
4. runtime waiting-for-user / steerable idle cue -> `waiting_input`
5. idle with recent assistant completion and no error cue -> `completed`
6. otherwise -> `unknown`

## First-pass heuristic suggestions

Because the prototype currently leans on rollout parsing, the initial implementation may need heuristics.

### `failed` cues
Potential cues:
- explicit error payload from runtime if available
- obvious failure language in the newest relevant assistant/tool block
- interrupted/failed terminal command with no later recovery

Examples of candidate text cues:
- `error`
- `failed`
- `exception`
- `traceback`
- unrecoverable tool/app-server error blocks

Caution:
- do not classify as `failed` from a single tool error if a later assistant block clearly recovered

### `waiting_approval` cues
Potential cues:
- explicit runtime approval state if available
- assistant or tool text clearly asking user to approve/confirm an action
- command/permission blocked language in recent blocks

Examples:
- `approval`
- `approve`
- `confirmation required`
- command blocked pending approval

Caution:
- separate normal questions from true approval gates

### `running` cues
Potential cues:
- active turn status from runtime read
- current terminal interaction target attached to an in-progress turn
- very recent runtime in-progress status

Preferred source:
- runtime turn status should outrank transcript heuristics

### `waiting_input` cues
Potential cues:
- assistant ended with a direct question/request for the user
- explicit runtime waiting state without active execution
- thread is idle after a prompt asking for missing information

Examples:
- `which option should I use?`
- `please confirm`
- `I need ... before I can continue`

Caution:
- not every question means blocked state; prefer questions near the end of the latest assistant response

### `completed` cues
Potential cues:
- no active turn
- no approval/failure/user-input blocking cue
- latest assistant block looks like a finished response

This is the default "healthy idle" state.

### `unknown` cues
Use when:
- no reliable recent signal exists
- conflicting signals tie
- rollout parsing is incomplete/corrupt

## Precedence examples

### Example A
- tool error appears
- later assistant says issue fixed and gives final result

Result: `completed`, not `failed`

### Example B
- latest assistant asks a product decision question
- no active turn

Result: `waiting_input`

### Example C
- latest runtime status says in progress
- transcript has old approval language

Result: `running`

### Example D
- command is blocked pending approval
- no active running turn

Result: `waiting_approval`

## Suggested internal representation

Recommendation:

```js
{
  type: 'waiting_input',
  source: 'runtime' | 'rollout' | 'heuristic',
  confidence: 'high' | 'medium' | 'low',
  reason: 'latest assistant asks for confirmation'
}
```

Public payload can stay simpler at first:

```js
state: 'waiting_input'
```

Or, if useful without much extra cost:

```js
state: {
  type: 'waiting_input',
  confidence: 'medium'
}
```

## UI mapping recommendation

### Visual emphasis
- `failed` -> strongest warning emphasis
- `waiting_approval` -> strong attention emphasis
- `waiting_input` -> attention but softer than approval
- `running` -> active/in-progress emphasis
- `completed` -> subdued success/neutral
- `unknown` -> muted neutral

### Sort priority
Recommended inbox priority:
1. `failed`
2. `waiting_approval`
3. `waiting_input`
4. `running`
5. `unknown`
6. `completed`

## Implementation recommendation

### Step 1
Implement a small pure function on the server side:
- input: thread metadata + recent rollout blocks + optional runtime state
- output: normalized internal state object

### Step 2
Expose normalized state in:
- `/api/threads`
- `/api/session`

### Step 3
Render compact state badges in:
- thread list
- selected-thread header/sticky context

### Step 4
Build inbox/attention filtering using the same normalized state field.

## Validation checklist

Before calling the model good enough:
- sample a mix of active, idle, blocked, and noisy threads
- verify recovered threads do not stay stuck as `failed`
- verify conversational question threads do not all become `waiting_input`
- verify mobile badge treatment does not overwhelm the list

## Recommended next move

Start with **#6** first.

Reason:
- it reduces thrash before touching API/UI
- it lets #7 and #8 build on one explicit contract
- it makes the inbox feature in #2 much easier to design cleanly
