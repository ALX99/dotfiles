---
name: architect-workflow
description: Use when building a new feature or making non-trivial changes that benefit from upfront design — orchestrates architect, critic, implementation, and risk review phases
---

# Architect Workflow

Orchestrate a full design-to-implementation pipeline using independent Claude agents with persistent sessions. Agents communicate through files — the orchestrator never passes content in prompts.

## Phases

| Phase | Agent | Mode | Rounds |
|-------|-------|------|--------|
| 1. Architect | Main agent ↔ User | Interactive | Until user approves |
| 2. Critic | `critic` ↔ `architect` | Autonomous | 1 + conversation (max 3) |
| 3. Implement | `implementer` | Autonomous | 1 |
| 4. Risk Review | `risk-reviewer` ↔ `implementer` | Autonomous | 2 fixed |

User gates: approve draft spec (after phase 1), approve post-critic spec (after phase 2).

Agents are defined in `~/.claude/agents/`. Each is an independent Claude Code process with persistent session context.

## Plan Directory

All agent communication goes through `docs/plans/<topic>/`. The orchestrator creates this directory and tells agents where to read/write. **Never pass file content in prompts — only pass file paths.**

```
docs/plans/<topic>/
  spec.md                    # The specification (written by main agent, updated by architect)
  critic-round-1.md          # Critic's initial review
  architect-round-1.md       # Architect's response to critic
  critic-round-2.md          # Critic's follow-up (if not satisfied)
  architect-round-2.md       # Architect's follow-up response
  ...                        # Up to round 4
  risk-findings.md           # Risk reviewer's findings
  risk-response.md           # Implementer's response to findings
  risk-findings-2.md         # Risk reviewer's re-review
  risk-response-2.md         # Implementer's final response
```

### Spec Format

```markdown
# <Topic> Spec

## Goal
What we're building/changing and why (if relevant).

## Approach
Chosen approach and why alternatives were rejected.

## Design
Architecture, components, data flow.
Include concrete code snippets showing the intended changes —
diffs, new functions, config structures, type definitions.
This is the implementation blueprint.

## Non-goals
What this explicitly does NOT do.
```

---

## Phase 1: Architect (Main Agent ↔ User)

Run directly in the main conversation. No subagent.

1. **Gather context** — read relevant files, recent commits, project structure.
2. **Ask clarifying questions** — one at a time, prefer multiple choice. Focus on purpose, constraints, success criteria.
3. **Explore approaches** — propose 2-3 options with tradeoffs. Lead with your recommendation and why.
4. **Present spec incrementally** — 200-300 word sections, validate each with the user.
5. **Create the plan directory** and **write the spec** to `docs/plans/<topic>/spec.md`.

Phase 1 ends when the user approves the spec.

---

## Phase 2: Critic ↔ Architect (Autonomous)

Announce: "Running critic review — will show you results when done."

```bash
CRITIC_ID=$(uuidgen)
ARCHITECT_ID=$(uuidgen)
PLAN_DIR="docs/plans/<topic>"
```

### Round 1

```bash
# Critic reads spec and codebase, writes review
claude -p --agent critic --session-id "$CRITIC_ID" \
  "Review the spec at $PLAN_DIR/spec.md. Read it and the relevant codebase files, then challenge the design. Write your review to $PLAN_DIR/critic-round-1.md"

# Architect reads critic's review, responds, updates spec
claude -p --agent architect --session-id "$ARCHITECT_ID" \
  "A critic reviewed your spec. Read the spec at $PLAN_DIR/spec.md and the critic's review at $PLAN_DIR/critic-round-1.md. Respond to each challenge and write your response to $PLAN_DIR/architect-round-1.md. Update the spec file with any revisions."
```

### Round 2: Conversation (max 3 exchanges)

```bash
MAX_EXCHANGES=3
for i in $(seq 2 $((MAX_EXCHANGES + 1))); do
  prev=$((i - 1))

  # Critic reads architect's response and updated spec, writes follow-up
  claude -p --resume "$CRITIC_ID" \
    "Read the architect's response at $PLAN_DIR/architect-round-$prev.md and re-read the spec at $PLAN_DIR/spec.md (it may have been updated). Push back on weak answers. Accept solid ones. Write your review to $PLAN_DIR/critic-round-$i.md. End with SATISFIED if no remaining concerns."

  # Stop if critic is satisfied
  if grep -q "SATISFIED" "$PLAN_DIR/critic-round-$i.md"; then
    break
  fi

  # Architect reads critic's follow-up, responds, updates spec
  claude -p --resume "$ARCHITECT_ID" \
    "Read the critic's follow-up at $PLAN_DIR/critic-round-$i.md. Respond and write to $PLAN_DIR/architect-round-$i.md. Update the spec file if needed."
done
```

### After Conversation

Read the final critic review file to get a summary of what was challenged and resolved. Read the spec to see what changed.

Present to the user:
- What the critic challenged and how it was resolved (read from the review files)
- The final spec (read from `spec.md`)

Ask: "Ready to implement?"

---

## Phase 3: Implement (Autonomous)

```bash
IMPL_ID=$(uuidgen)
claude -p --agent implementer --session-id "$IMPL_ID" \
  "Implement the spec at $PLAN_DIR/spec.md."
```

Record the commit SHA before and after to get the diff for phase 4:

```bash
PRE_IMPL_SHA=$(git rev-parse HEAD)
# ... run implementer ...
POST_IMPL_SHA=$(git rev-parse HEAD)
```

---

## Phase 4: Risk Review ↔ Implementation (Autonomous)

```bash
RISK_ID=$(uuidgen)
DIFF_RANGE="$PRE_IMPL_SHA..$POST_IMPL_SHA"
```

### Round 1

```bash
# Risk reviewer examines spec + diff, writes findings
claude -p --agent risk-reviewer --session-id "$RISK_ID" \
  "Review the changes for the spec at $PLAN_DIR/spec.md. The diff is available via: git diff $DIFF_RANGE. Write your findings to $PLAN_DIR/risk-findings.md"

# Implementer reads findings, fixes or pushes back
claude -p --resume "$IMPL_ID" \
  "Read risk review findings at $PLAN_DIR/risk-findings.md. Fix what you agree with, push back on what you don't. Write your response to $PLAN_DIR/risk-response.md. Commit fixes."
```

### Round 2

```bash
# Risk reviewer re-reviews
claude -p --resume "$RISK_ID" \
  "Read implementer's response at $PLAN_DIR/risk-response.md and check any new commits. Write your follow-up to $PLAN_DIR/risk-findings-2.md. End with CLEAN if no remaining issues."

# Implementer addresses remaining issues
claude -p --resume "$IMPL_ID" \
  "Read risk reviewer follow-up at $PLAN_DIR/risk-findings-2.md. Address remaining issues, write response to $PLAN_DIR/risk-response-2.md, and commit."
```

### After Round 2

Read the findings and response files. Present to the user:
- Findings and severity
- What was fixed
- What was accepted as-is (with reasoning)

---

## Key Rules

- **Never pass file content in prompts.** Only pass file paths. Agents read/write files themselves.
- **Critic never modifies the spec.** It writes review files only (Edit tool is disallowed).
- **Risk reviewer never modifies code.** It writes findings files only (Edit tool is disallowed).
- **Architect updates the spec file directly** when revising based on critic feedback.
- **Phase 2 conversation loops up to 3 exchanges.** Stops early if critic writes `SATISFIED`.
- **Reuse session IDs within a phase.** `--session-id` for first call, `--resume` for subsequent calls.
