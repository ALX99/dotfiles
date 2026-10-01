# Harness learning

An opt-in learning workflow for Pi with two paths:

- **Interactive learning:** the model records evidence and proposes small
  repository-scoped procedures; the user runs decision probes and approves.
- **Automated laboratory:** an explicitly authorized headless run diagnoses
  coding-task failures, proposes procedures, tests them in Docker, and selects
  experimental versions. Deployment still requires user review and approval.

See [Laboratory experiments](lab/README.md) for the experiment schema, CLI,
coding-task evaluator, budgets, and sandbox limitations.

The mutable surface is **procedural guidance**, not extension code, tool
implementations, `AGENTS.md`, or the evaluator. Neither path rewrites harness
source, commits changes, schedules background calls, or automatically deploys
guidance. Laboratory coding tasks edit only disposable container workspaces.

```text
exact session quotes → candidate procedure → independent decision probes
                                            → human approval → scoped guidance
                                                              → rollback
```

This is infrastructure for gated procedural learning. It does not establish
that a procedure improves everyday Pi coding performance. Decision probes test
next-action choices; laboratory tasks use a separate bounded coding runtime,
not a replay of native Pi sessions.

## Load

Requires Node 26+ and the parent extension package's locked dependencies.
`mise run pi:deps` installs those dependencies in both the repository and
existing installed runtime trees; it does not install this extension's links.

With the repository's extension dependencies installed, run from the dotfiles
repository root:

```sh
pi --offline -e "$PWD/home/.pi/agent/extensions/harness-learning/index.ts"
```

This loads the extension for that invocation without changing settings or
installing links. `--offline` disables Pi startup network operations; it does
**not** prevent later prompts or `/harness evaluate` from making paid requests.
Keep session persistence enabled: `--no-session` cannot supply durable evidence.

The normal Stow installation makes this directory discoverable under
`~/.pi/agent/extensions/`. An explicit `-e` invocation does not require the broad
`mise run install` task. Do not load both the installed and repository entry
points in the same invocation.

## Workflow

1. During ordinary tasks, ask the model to record an observed recurring problem
   using `harness_evidence`. It must quote exact visible text from the current
   session branch. Evidence is untrusted and does not change guidance.
2. Gather matching evidence in at least **two distinct persistent sessions** in
   the same scope. Multiple entries in one session do not satisfy recurrence.
   Prefer independent tasks, not copies of the same failure.
3. Ask the model to inspect `harness_evidence` with `action: "list"` and submit
   a minimal procedure with `harness_propose`. It must name the current
   `parentVersion`, relevant evidence IDs, and an active replacement ID or
   `null`. The returned candidate ID is used below.
4. Read `/harness review <candidate-id>`. Check applicability, causal reasoning,
   verification, exceptions, and the quoted evidence yourself.
5. Independently author a probe suite outside the model's working context.
   Import it with `/harness suite /absolute/path/to/probes.json`. Do not ask the
   proposing agent to write, inspect, or tune against expected answers.
6. Select the physical provider/model you intend to use. Run
   `/harness evaluate <candidate-id>` and confirm its request budget.
7. Review the reported gate result and perform task-level verification as
   appropriate. A passing probe run only makes the candidate eligible:
   `/harness approve <candidate-id> <reason>` still requires your confirmation.
8. Reject unsuitable candidates or roll back a deployed procedure. Rejections,
   evaluations, and previous versions remain in history.

All `/harness` commands require an interactive TUI. Except for cancellation,
they also require an idle agent and no other running harness command.

| Command                                         | Operation                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/harness` or `/harness status`                 | Show scope, version, active IDs, counts, latest suite ID, and recent versions.                          |
| `/harness review <candidate-id>`                | Show the proposal, supporting evidence, and recorded decision.                                          |
| `/harness suite <path>`                         | Confirm and snapshot an independently authored JSON suite. Relative paths resolve from the session cwd. |
| `/harness evaluate <candidate-id>`              | Confirm and run paid, read-only, paired decision probes. Does not approve.                              |
| `/harness approve <candidate-id> <reason>`      | Confirm promotion after the gate passes for the selected model.                                         |
| `/harness reject <candidate-id> <reason>`       | Confirm rejection without deleting the candidate.                                                       |
| `/harness lab-review <run-id>`                  | Review experimental procedures, selection history, gate reasons, and task verification outcomes.        |
| `/harness lab-release <run-id> <reason>`        | Confirm deployment of a completed, passing lab run after current-parent and physical-model checks.      |
| `/harness rollback <version-id\|root> <reason>` | Confirm restoration as a new version. `root` restores an empty pool.                                    |
| `/harness cancel`                               | Cancel the outstanding command, including evaluation.                                                   |

For example:

```text
/harness status
/harness review <candidate-id>
/harness suite /absolute/path/to/independently-authored-probes.json
/harness evaluate <candidate-id>
/harness approve <candidate-id> Applicable to this repository and verified on a real task
/harness rollback root Procedure activated outside its intended conditions
```

Replace angle-bracket placeholders with IDs reported by the tools or commands.
Changing sessions, navigating the session tree, selecting a model, starting an
agent run, or shutting down cancels outstanding command work.

## Model-facing tools

`harness_evidence` accepts one of:

```json
{ "action": "anchors" }
```

```json
{ "action": "list" }
```

For `action: "record"`, supply `entryId`, `quote`, `behavior`, and `attribution`.
`anchors` shows up to 12 recent current-branch entry IDs and text previews;
`list` shows the current parent, active IDs, recent evidence, and candidates.
Neither exposes probe prompts, expected answers, or raw evaluation outputs.

Anchors can be visible user/assistant text, ordinary tool-result text, or Bash
execution output. Thinking, tool arguments/details, synthetic summaries, and
the learning tools' own outputs cannot serve as evidence. Session identity,
canonical session-file path, event ID, timestamp, and model identity are
derived by the extension, not supplied by the model.

`harness_propose` accepts:

| Field           | Contract                                                                         |
| --------------- | -------------------------------------------------------------------------------- |
| `parentVersion` | Current version ID from `harness_evidence list`; initially `root`.               |
| `replaces`      | Active candidate ID for the same behavior, or `null` for a new behavior.         |
| `procedure`     | `behavior`, `title`, `trigger`, `action`, `verify`, and `avoid`.                 |
| `hypothesis`    | Why this procedure should address the evidenced problem; at most 500 characters. |
| `evidenceIds`   | 2–12 unique matching evidence IDs from at least two distinct sessions.           |

Behavior names use lowercase letters, digits, `/`, and `-`, starting with a
letter; for example, `editing/generated`. Procedure text limits are: title 100,
trigger 300, action 700, verify 300, and avoid 300 characters. Evidence quotes
are limited to 1,500 characters. Text must be nonempty and unpadded; unknown
fields are rejected.

Only evidence attributed to `HARNESS_DEFICIENCY`, `KNOWLEDGE_DEFICIENCY`, or
`RETRIEVAL_FAILURE` can support a proposal. The other accepted evidence labels
are `MODEL_LIMITATION`, `TOOL_FAILURE`, `ENVIRONMENT_FAILURE`,
`EVALUATOR_FAILURE`, `STOCHASTIC_FAILURE`, and `UNKNOWN`; these cannot authorize
procedural learning.

Quote authenticity is checked, but attribution and the hypothesis remain
claims to review. This interactive path has no automatic failure mining or
causal classifier. The separate laboratory uses its own development-task
traces, not automatic ingestion of ordinary Pi sessions.
Duplicate procedures are blocked against the same parent or an active
procedure, including cosmetic title changes. Rejected candidates are not
silently retried as identical proposals.

## Independent probe suite

The imported file is a JSON object with `name` and `cases`. It must be a regular
file no larger than 64 KiB; symlink endpoints are refused. Import preserves
source-file permissions and snapshots the suite in learning history. Unknown
fields are rejected.

Each case has this shape. This one-case snippet is **schema illustration only**,
not a runnable suite or an independent production evaluator:

```json
{
	"name": "independently-authored-suite",
	"cases": [
		{
			"id": "case-1",
			"behavior": "editing/generated",
			"kind": "target",
			"prompt": "An independently authored scenario.",
			"choices": [
				{ "id": "A", "text": "One possible next action." },
				{ "id": "B", "text": "Another possible next action." }
			],
			"expectedChoice": "A"
		}
	]
}
```

- A suite needs **4–12 cases** with unique IDs. Names are limited to 100
  characters, prompts to 2,000, and choice text to 500.
- Each case needs 2–6 uniquely identified choices. `expectedChoice` must name
  one of them. IDs start with a letter or digit and otherwise allow letters,
  digits, `.`, `_`, `:`, `/`, and `-`, up to 200 characters.
- The proposed behavior needs `target`, `control`, and `holdout` cases.
  Target cases test the diagnosed problem; controls test when the procedure
  should **not** activate; holdouts test separate unseen scenarios.
- At least one `regression` case is required. Every existing active behavior
  also needs coverage by a `regression` or `target` case.

Expected answers are not sent in probe requests. They are still present in
same-account files. A `holdout` label does not enforce secrecy or prevent reuse.
Keep real holdouts independent; the test fixtures in this package are synthetic,
not production evaluation data.

## Evaluation and promotion

Every case runs three paired repeats: one request with current model-applicable
guidance and one with the proposed pool. Requests are independent, with
counterbalanced arm order. They use a fixed choice-ID response instruction and
send only the scenario, choices, and applicable guidance—no tools, session
history, case-kind labels, or expected answers.

Promotion requires:

- Exactly one pair per case and repeat.
- Valid baseline choice IDs, and correct candidate answers on **every** repeat
  of every target, control, holdout, and regression case.
- At least one targeted baseline error corrected by the candidate.
- The latest recorded evaluation, the current parent version, and the latest
  configured suite. A new suite or version makes earlier results ineligible.
- The same selected `provider/model-id` used for evaluation and approval.

Eligibility never automatically promotes. A failed or interrupted run cannot
produce a new authorizing evaluation. Complete evaluations that fail the gate
are retained. If a candidate becomes stale, propose it against the new parent
and evaluate again. Already decided candidates cannot be decided again.

The repository-wide active pool holds at most **five procedures** and **6,000
rendered characters**, with one procedure per behavior. Approval replaces only
the explicitly named procedure. Guidance activates only for its evaluated
provider/model ID. Switching models does not transfer approval; routed probe
responses reporting a different model ID are refused.

Guidance is rebuilt on each request. Ordinary providers receive an ephemeral
context message; OpenAI Responses transports receive request-local
`instructions`, so remote compaction's replacement of `input` cannot discard
it. The extension does not append durable guidance messages. Rollback, reload,
and model switching therefore change the guidance used on subsequent requests.
They cannot undo files already edited or erase a model's earlier responses.

## Resource limits and billing

| Limit                               | Value                                 |
| ----------------------------------- | ------------------------------------- |
| Requests per evaluation             | 24–72: cases × 3 repeats × 2 arms     |
| Requested output tokens per request | 256                                   |
| Local request deadline              | 30 seconds                            |
| Local total evaluation deadline     | 10 minutes                            |
| Client retries                      | None                                  |
| Streamed text plus thinking         | At most 8,192 characters per response |
| Retained text                       | At most 2,048 characters per response |

Evaluation uses the selected model's configured credentials. **There is no hard
dollar ceiling.** Providers may interpret token limits differently or bill
additional reasoning. Local abort/deadline enforcement does not guarantee
remote computation or billing stops.

Each completed response records reported usage in a custom session entry named
`harness-learning:probe-usage`, even if later validation fails. The completed-run
notification reports tokens and cost. These entries are **not included in Pi's
ordinary session totals**. Interrupted streams can have billed usage that was
never reported. Guidance also increases subsequent ordinary request context.
Token cost, latency, and end-to-end success are not promotion objectives here.

## Storage, rollback, and trust boundaries

Storage is outside the repository:

```text
~/.pi/harness-learning/<sha256(canonical-scope)>/history.json
```

Scope is the canonical Git top-level path, or canonical cwd outside Git.
Subdirectories share a repository's history; branches at that path share it
too. Separate worktree/clone paths and moved repositories have different
scopes. Provider/model binding is separate from this repository identity.
`PI_CODING_AGENT_DIR` does not relocate this store.

The format-1 document records evidence, proposals, suite snapshots, exact
evaluation text, decisions, and rollback events. Versions record their parent,
active candidate IDs, and any restored version. The state is replayed from this
one logical history. Rollback appends a new version rather than deleting past
events or rewriting Git history.

Directories use mode `0700`; files use `0600`. Bounded reads refuse symlink
endpoints and hard-linked files. Cross-process exclusive locks protect the
read/validate/write transaction. Writes sync the replacement file before atomic
rename; this is not a claim of full power-loss durability or tamper-proof
storage. Invalid histories are reported, not silently reset.

History stops at **1,000 events or 4 MiB**. There is no automatic eviction,
consolidation, migration, or garbage collection. If a crash leaves `write.lock`,
stop concurrent writers and inspect it before manually removing it; never
remove a live writer's lock.

These are API and review boundaries, **not an adversarial sandbox**. Extensions
and agents with ordinary Bash/file tools run under the same Unix account and
can access evaluator files, learning history, and source. An external protected
evaluator and permission boundary are required for genuinely blind evaluation
or adversarially immutable promotion policy.

Do not record secrets: quotes and canonical session paths persist in history,
and evidence/candidate tool results can enter model context. There is no secret
redactor. Approved text still needs human review for conflicts and overbroad
instructions; it never grants additional permissions.

## Verify

From the repository root:

```sh
mise run pi:check
```

To run only this feature's offline tests:

```sh
cd home/.pi/agent/extensions
PI_OFFLINE=1 node --test 'harness-learning/tests/*.test.ts'
PI_OFFLINE=1 node --test 'harness-learning/lab/tests/*.test.ts'
```

The loading test uses Pi's real extension loader in an isolated temporary
directory. Integration tests use real session/history/storage with fake UI,
Git, and provider boundaries; they do not make paid requests. These tests
verify implementation contracts, not a real model's coding improvement.
Real-Docker tests require an explicit local-image opt-in; see the laboratory
guide. They use fake model responses and do not issue paid requests.
