# Forensics

Diagnosis is the deliverable; do not fix unless authorized.

1. For a supplied artifact, preserve the original and identify format, capture conditions, and parser. For a live symptom, capture the signal needed to answer the question; account for capture overhead and production safety.
2. Establish what is measured, units, interval, sampling, symbols, and blind spots. CPU samples are not call counts; flame graph horizontal position is not chronology. Infer timing, frequency, or causality only where supported.
3. Reduce evidence to a relevant hot path, retention chain, wait reason, or event sequence. Map it to source; corroborate the mechanism with a paired capture, safe instrumentation, or controlled reproduction where practical.
4. Report artifact and source locations, evidence, confidence, and limitations. Distinguish confirmed mechanisms from hypotheses. Route an authorized fix to `bug-fix.md` or `perf-issue.md`.
