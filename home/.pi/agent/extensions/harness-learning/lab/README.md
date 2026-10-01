# Laboratory experiments

An explicitly launched, bounded self-improvement loop for **procedural
guidance**. The controller runs coding tasks, asks a researcher model for a
minimal hypothesis-backed procedure, evaluates it, and retains or rejects it
in a separate experimental lineage. The researcher and executor can be
different physical models.

```text
frozen production baseline → development seed tasks
                                      ↓
                      recurring failures across distinct tasks
                                      ↓
                       tool-free researcher → procedure
                                      ↓
                    repeated paired development evaluations
                                      ↓
                      automatic lab-only selection/rejection
                                      ↓
                       next proposal, or stop development
                                      ↓
               one final paired holdout against original baseline
                                      ↓
                  human review → confirmed production release
```

There are no scheduled experiments, automatic deployment, harness-source
rewrites, or commits. No ordinary Pi sessions are mined automatically. Coding
tasks modify only disposable containers. The interactive evidence/probe
workflow remains available independently; see [Harness learning](../README.md).

## Prerequisites

- Node 26+ and the parent extension package's locked dependencies.
- An independently authored experiment JSON and representative executable
  checks. Test fixtures are synthetic, not production evaluators.
- A running Docker daemon and a trusted **already-local, digest-pinned Linux
  image** with Node 26+, `/usr/bin/env`, and the task's required dependencies.
  Images declaring Docker volumes are refused. Provision the daemon/image
  separately; this runner never starts the daemon or pulls images.
- Physical provider/model IDs and credentials available to Pi's headless
  `ModelRuntime`. Normal extensions are not loaded; models supplied only by a
  live extension and virtual routing entries are not available here. Both the
  researcher and target must return their configured physical model identity.

Inspect existing local images without pulling:

```sh
docker image ls --digests --format '{{.Repository}}@{{.Digest}} {{.Tag}}'
```

## Commands

From the dotfiles repository root:

```sh
# Offline validation: no model initialization, Docker access, or store writes.
mise run improve:harness -- plan /absolute/experiment.json --scope /path/to/project

# Paid execution: authorizes exactly one new run, not deployment.
mise run improve:harness -- run /absolute/experiment.json trial-001 \
  --scope /path/to/project --allow-paid

# Offline reports: no requests and no initialization of missing runs.
mise run improve:harness -- status trial-001 --scope /path/to/project
mise run improve:harness -- review trial-001 --scope /path/to/project
```

`--scope` defaults to the command's cwd. The mise entry point runs from the
dotfiles root, so specify another project's scope explicitly. Scope resolves
to the canonical Git top-level, or canonical cwd outside Git. Subdirectories
and branches at one root share production history; separate worktree paths do
not. Scope selects history and the baseline; it does **not** mount or copy the
project into Docker. Task files come only from the inline suite.

`plan` derives the current production parent and model-applicable procedures;
a launch file cannot supply its own baseline. It prints limits and request
upper bounds, but does not check credentials, model availability, or Docker.
`run` initializes models and inspects the local image before creating history.
Credentials or container execution can still fail later.

The package alternative, from `home/.pi/agent/extensions/`, is
`pnpm run improve:harness <subcommand> ...`; its default scope is that cwd.
`PI_OFFLINE=1` disables Pi startup networking, **not authorized provider calls**.
Only plan/status/review are request-free.

Run IDs use 1–100 ASCII letters, digits, `_`, or `-`, starting with a letter or
digit. A run's configuration and baseline are immutable. Existing runs cannot
be overwritten, resumed, or launched by a second controller. A passing run
exits successfully; stopped/failed runs exit unsuccessfully and retain their
history. SIGINT/SIGTERM request cancellation, accounting, and container cleanup.

## Experiment JSON

All fields below are required. Unknown fields are refused. This is a **schema
illustration, not a runnable experiment**: replace the model IDs and image
digest and supply all six or more independently authored tasks.

```json
{
	"researcherModel": "provider/researcher-model-id",
	"targetModel": "provider/target-model-id",
	"image": "node@sha256:0000000000000000000000000000000000000000000000000000000000000000",
	"suite": {
		"name": "independently-authored-coding-suite",
		"tasks": []
	},
	"limits": {
		"maxCandidates": 3,
		"repeats": 3,
		"maxRequests": 400,
		"maxOutputTokens": 1024,
		"maxTotalTokens": 500000,
		"maxReportedCostUsd": 5,
		"maxWallTimeMs": 3600000,
		"maxRequestTimeMs": 30000,
		"maxTaskTimeMs": 90000,
		"maxTurnsPerTask": 4
	}
}
```

The imported regular file is bounded to 512 KiB + 4 KiB; symlink endpoints are
refused and source permissions are preserved. The suite itself is capped at
512 KiB. Do not put secrets in tasks, source files, or verification output.

### Coding tasks

Each task has this shape. This tiny example illustrates transport and checking,
not a useful independent benchmark:

```json
{
	"id": "target-one",
	"behavior": "editing/generated",
	"kind": "target",
	"prompt": "Change the exported value to 2 while preserving the module interface.",
	"files": [{ "path": "src/value.mjs", "content": "export const value = 1;\n" }],
	"solutionPaths": ["src/value.mjs"],
	"verify": {
		"files": [
			{
				"path": "check.mjs",
				"content": "import assert from 'node:assert/strict'; import {value} from '/workspace/src/value.mjs'; assert.equal(value, 2);\n"
			}
		],
		"argv": ["node", "/verify/check.mjs"]
	}
}
```

- A suite needs **6–12 tasks** with unique IDs: at least two `target`, one
  `control`, one `regression`, and two `holdout` tasks. Controls test when a
  procedure should not activate; holdouts test independent transfer scenarios.
- Behavior names use the production procedure schema, such as
  `editing/generated`. Candidate evidence must show failures in two distinct
  development tasks for the same behavior. Repeats of one task do not suffice.
  Each existing target-model procedure needs a matching `regression` task.
- Prompts have at most 4,000 characters. Task files and verifier files each
  need 1–24 entries, at most 16,384 characters per file and 64 KiB UTF-8 total
  per set. Paths are relative ASCII POSIX paths without `.`/`..` segments,
  duplicates, or file/directory overlaps.
- `solutionPaths` lists 1–8 unique, non-overlapping paths. Only listed regular
  UTF-8 files are exported; links, special files, binary data, and oversized
  output are refused. Changes to unlisted files are discarded.
- `verify.argv` has 2–16 arguments and must start with `node` and reference a
  supplied `/verify/` file. It is argv, not an implicit shell command.

The target receives the prompt and initial file paths, with container-local
`read`, `write`, and `exec` tools. It must finish within its model-turn limit.
The agent container never receives verifier files. A **fresh** container gets
the original fixture with explicitly exported solution files overlaid, plus
root-owned read-only workspace/verifier files. The verifier runs nonroot.
Exit 0 passes; ordinary nonzero verification results fail. Infrastructure,
model, timeout, or interrupted executions are invalid, not ordinary task
failures from which the researcher can infer a harness weakness.

### Limits

There are no implicit limit defaults.

| Field                | Allowed range / meaning                                        |
| -------------------- | -------------------------------------------------------------- |
| `maxCandidates`      | 1–10 proposed procedures                                       |
| `repeats`            | 3–5 paired repeats per development/holdout task                |
| `maxRequests`        | 1–400 researcher and executor requests combined                |
| `maxOutputTokens`    | 64–8,192 requested output tokens per call                      |
| `maxTotalTokens`     | 64–5,000,000 reserved/reported token budget                    |
| `maxReportedCostUsd` | Greater than 0, at most 1,000 reported US dollars              |
| `maxWallTimeMs`      | 1,000–3,600,000 local run deadline                             |
| `maxRequestTimeMs`   | 1,000–120,000 local request deadline                           |
| `maxTaskTimeMs`      | 1,000–600,000 local task deadline                              |
| `maxTurnsPerTask`    | 1–30 model calls per coding task, including the final response |

Output tokens must fit the total budget, and request ≤ task ≤ run deadlines.
Calls are sequential with no client retries. Each call is durably reserved
before dispatch; conservative context-byte-plus-output reservations are not
tokenizer measurements. Actual reported usage, including overshoot, is
retained. Failed, interrupted, or unknown-usage requests prevent continuation
and release. Output and retained traces also have fixed size bounds.

With `D` development tasks, `H` holdouts, `R` repeats, `T` turns, and `C`
candidates, request upper bounds are:

```text
seed:                    D × T
development/candidate:   1 + D × R × 2 × T
final holdout:           H × R × 2 × T
total:                  seed + C × development/candidate + final holdout
```

The controller reserves request capacity for another complete candidate matrix
**and** final holdout before proposing again. Smaller budgets are allowed but
may stop without any candidate. Token, cost, and elapsed-time budgets can stop
earlier; request capacity does not guarantee completion.

**There is no provider-enforced dollar ceiling.** The reported-cost threshold
stops subsequent work; one request can overshoot it. Provider accounting,
reasoning tokens, and model cost metadata may differ from local estimates.
Local aborts do not guarantee remote computation or billing stops. Interrupted
streams may incur unreported charges. Usage is recorded in lab history, not
Pi's ordinary session totals. Cost and latency are not selection objectives.

## Selection, holdout, and deployment

Seed tasks run once with the frozen production pool. The tool-free researcher
receives bounded development traces, verifier outcomes, procedures, and prior
candidate decisions—not verifier source or holdout tasks. Attribution and
causal hypotheses remain model claims.

Each candidate is checked against the current experimental parent. Development
evaluation counterbalances baseline/candidate order and reruns **all**
development tasks. Acceptance requires valid baseline executions, every
candidate repeat passing, and at least one corrected target failure for the
changed behavior. Rejections and their reasons remain available to the next
proposal. Duplicate procedures are refused.

The all-development-tasks-pass gate is deliberately conservative: an accepted
candidate normally removes all recurring development failures, so research
then stops instead of inventing further changes to repaired behavior.

After development ends, one final repeated paired matrix compares the
shortlisted **whole pool** against the original frozen production baseline.
Every candidate holdout repeat must pass and at least one baseline holdout
failure must be corrected. An already-perfect holdout baseline therefore does
not establish improvement and cannot authorize release. Holdout failure,
interruption, or partial results cannot be retried, resumed, or fed into
further proposals in that run.

To deploy, load the learning extension in Pi for the same repository, select
the evaluated physical target model, and run while idle:

```text
/harness lab-review trial-001
/harness lab-release trial-001 Reviewed passing task evidence and procedure scope
/harness rollback <previous-version-id> Observed an activation regression
```

Review shows procedures, ancestry, decisions, gate reasons, and per-task
verification outcomes. Release requires confirmation and rechecks the current
production parent, exact model-applicable baseline, canonical repository,
physical provider/model ID, passing final evidence, budgets, and combined pool
limits. Identity/lifecycle changes cancel it. The CLI and model tools cannot
release. Other models' procedures are preserved.

The complete lab witness is retained and replayed in production history.
Release neither fabricates decision-probe scores nor depends on the external
lab file for future replay. Ordinary model-bound request-local guidance and
rollback apply after deployment. Rollback cannot undo already edited files.

## Storage and trust limitations

```text
~/.pi/harness-learning/<sha256(canonical-scope)>/lab/<runId>/history.json
```

Each run has one private, locked, atomic logical history, capped at **2,000
events / 16 MiB**, without eviction. Production retains its **1,000-event /
4-MiB** cap. A release whose complete witness cannot fit production capacity
fails without truncating evidence or changing the current version.
`PI_CODING_AGENT_DIR` does not relocate these stores.

Docker is the only backend; unavailable or refused containment fails closed,
never falling back to host execution. Containers have no host bind mounts,
network, credentials, or Docker socket, a read-only image root, all
capabilities dropped, no-new-privileges, UID/GID 65534, 1 CPU, 256 MiB memory
with no additional swap allowance, and 64 PIDs. Writable tmpfs is bounded: `/workspace` 16 MiB,
`/tmp` 8 MiB, plus `/verify` 16 MiB for verification. Image dependencies and
commands are still trusted; pinning a digest is not an image security audit.

The Docker daemon, host-side controller, image, and verifier implementation are
trusted. These restrictions are not a proof against container escapes or an
adversarially malicious evaluator. Verification can execute solution code:
independent checks must account for that code interfering with the test
process. Docker containment alone does not make a scorer tamper-proof.

History and suite files remain accessible to the same Unix account, including
ordinary agents with Bash/file tools. Holdouts are kept out of researcher
requests, not cryptographically hidden or externally protected. Final-only
use is enforced **per run**; reusing the same holdouts across new runs can
still leak selection feedback. Use fresh independent release tasks and an
external permission boundary for genuinely blind, adversarial evaluation.

The executor is a bounded coding runtime with three tools—not a native Pi
session with your extensions, context management, skills, or ordinary tool
set. Passing these small repeated matrices is evidence about those tasks, not
proof of everyday transfer, statistical significance, or open-ended recursive
acceleration. There is no built-in production benchmark suite.

Normal cancellation removes containers and records outcomes, but crashes,
SIGKILL, daemon failure, or cleanup failure can leave resources. Inspect
`docker ps -a --filter label=pi.harness-learning.lab=true` and stale store locks
before manual recovery; do not delete a live writer's lock. Interrupted runs
remain non-resumable even after cleanup.

## Verification

From `home/.pi/agent/extensions/`:

```sh
# Offline domain/integration tests; opt-in Docker tests are skipped.
PI_OFFLINE=1 node --test 'harness-learning/tests/*.test.ts' \
  'harness-learning/lab/tests/*.test.ts'

# Real containment/cleanup tests; choose an already-local trusted image.
HARNESS_LAB_TEST_IMAGE='node@sha256:<local-image-digest>' \
  PI_OFFLINE=1 node --test harness-learning/lab/tests/docker-smoke.test.ts
```

The Docker tests never pull an image or start a daemon. They use fake model
responses, including for the full task-execution smoke test; no paid model
evaluation occurs. For the repository gate, run `mise run pi:check` from the
repository root. Implementation tests do not establish real-model improvement.
