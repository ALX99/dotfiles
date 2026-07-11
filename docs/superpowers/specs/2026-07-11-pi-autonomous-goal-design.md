# Pi autonomous goal design

## Purpose

Add a global Pi extension that lets a user start a goal which continues
autonomously until an independent judge accepts evidence that the goal is
fulfilled. While active, the worker must not ask the user questions or stop
because it is uncertain. The user may steer work normally and may explicitly
terminate the loop with `/goal cancel`.

## Scope

This is a session-native extension under `home/.pi/agent/extensions/goal/`.
It does not fork Pi or replace its interactive runtime. It relies on Pi
extension commands, lifecycle events, custom tools, append-only custom
session entries, widgets, and a separate headless Pi process for judging.

## User interface

- `/goal <objective>` starts a new active goal. If a goal is active, it
  replaces it after recording the prior goal as superseded.
- `/goal` displays the active goal, phase, latest evidence, and latest judge
  verdict.
- `/goal cancel` is the sole command that permanently ends an active goal.
- Ordinary user messages remain normal Pi steering or follow-up messages.
  They refine work but do not end, pause, or replace the active goal.
- A widget above the editor displays the objective, cycle and attempt counts,
  phase (`working`, `judging`, or `retrying`), and latest judge feedback.
- A compact footer status identifies an active goal.

## State and persistence

Goal state is an append-only sequence of custom session entries. Each state
transition appends a complete event rather than mutating an external database.
On `session_start`, the extension rebuilds state by replaying the active
session branch. This makes state follow Pi's reload, resume, fork, and tree
branch semantics.

State includes:

- immutable goal ID and objective
- active, completed, cancelled, or superseded status
- cycle count and scheduling phase
- material strategy attempts and outcomes
- completion evidence submissions
- judge verdicts and feedback
- assumption-fallback flag
- retry metadata for transient worker or judge failures

## Worker lifecycle

1. Starting a goal records its state and starts a normal Pi worker run.
2. Before every worker run, the extension injects the objective, active state,
   previous strategies, judge feedback, and a strict instruction to act
   autonomously: do not ask questions and do not stop due to uncertainty.
3. The worker can use ordinary Pi tools and receives ordinary user steering.
4. When the worker settles, the extension schedules exactly one next worker
   cycle unless the goal has completed or been cancelled.
5. Scheduling is single-flight: a pending/running continuation token prevents
   duplicate runs after retries, lifecycle events, or queued messages.
6. Esc aborts only the current Pi run. It does not cancel the goal; the
   extension schedules the next cycle after settlement.

The extension exposes these model tools:

- `record_goal_attempt({ strategy, outcome })` records a materially distinct
  strategy and its outcome.
- `complete_goal({ summary, evidence })` submits evidence for judgment. It
  does not complete the goal directly.

Completion evidence must identify changed files when relevant, commands or
checks run with their results, and explain how that evidence fulfills the
original objective.

## Independent adjudication

`complete_goal` sends the original goal and the evidence bundle to a separate,
configured judge model through a fresh `pi --mode json --print --no-session`
process. The judge receives a constrained schema and returns either:

- `accept`, with a concise rationale, or
- `reject`, with concrete missing evidence or remaining work.

Only an accepted verdict records completion and ends the autonomous loop. A
rejection is persisted and injected into the next worker cycle. Starting a
goal fails before work begins if no separate judge model is configured.

## Autonomous uncertainty policy

The worker first tries reversible and safe alternatives. A failure is either:

- a recorded materially distinct strategy that did not resolve a blocker, or
- a judge rejection of a completion claim.

After three failures, the next worker instruction requires the worker to
state the necessary assumption, explain why safer alternatives were exhausted,
and take the least irreversible reasonable action. It then continues rather
than asking the user or stopping.

## Failure behavior

Worker/provider errors, compaction, reload, and session restoration preserve
an active goal and resume it. Judge subprocess errors preserve the goal,
show a retrying state, and retry with bounded backoff. Judge unavailability
never becomes completion. Explicit cancellation is the only user-controlled
terminal state besides judge-approved completion.

## Tests

Unit tests will cover:

- custom-entry replay across reload, resume, and branches
- command parsing, replacement, and cancellation
- single-flight continuation scheduling
- goal context injection alongside user steering
- evidence validation
- judge acceptance completing the goal
- judge rejection persisting feedback and continuing work
- the three-failure assumption directive
- worker and judge failure retry/backoff behavior

Integration-style tests will use fake worker-settlement and judge-process
adapters to prove that continuation is never duplicated and that the loop ends
only after accepted adjudication or explicit cancellation.
