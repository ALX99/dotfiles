---
name: engineering-workflow
description: Use for investigations, bug fixes, features, refactoring, performance work, reviews, or multi-phase engineering tasks; read the matching playbook before acting.
---

# Engineering Workflow

User and repository instructions own values, authorization, testing, and communication. This skill routes tasks; it grants no additional permissions.

## How to use

1. Establish the requested outcome, relevant instructions, current state, and whether edits are authorized.
2. Select and **read the full playbook or skill** below before acting. For compound tasks, read the relevant files and applicable specialist skills. If none fits, use a short investigate–act–verify sequence.
3. Keep planning and verification proportional to risk; work in coherent, independently verifiable increments. For asynchronous checks, wait for observable conditions with a timeout, not arbitrary sleeps. Investigate inconsistent results; a passing rerun does not explain a failure.
4. Review the actual diff and report the outcome, checks actually run, and material gaps.

Paths are relative to this skill directory.

## Playbooks

| Task | Read |
|---|---|
| Read-only question, explanation, or decision | [Investigation](playbooks/investigation.md) |
| Review a change or module | Use the existing `review` skill |
| Reproduce and fix a defect | [Bug fix](playbooks/bug-fix.md) |
| Diagnose and improve a performance issue | [Performance issue](playbooks/perf-issue.md) |
| Iteratively optimize a measurable outcome | [Hillclimb](playbooks/hillclimb.md) |
| Diagnose a live symptom or profiling artifact | [Forensics](playbooks/forensics.md) |
| Build or change behavior | [Feature](playbooks/feature.md) |
| Change structure while preserving behavior | [Refactoring](playbooks/refactoring.md) |
| Use a disposable experiment to decide | [Prototype](playbooks/prototype.md) |
| Drive one long task to completion | [Autonomous run](playbooks/autonomous-run.md) |
| Resume prior work | [Session pickup](playbooks/session-pickup.md) |
| Plan work spanning phases or PRs | [Multi-phase plan](playbooks/multi-phase-plan.md) |
| Open a PR when explicitly authorized | Use the existing `create-pr` skill |
