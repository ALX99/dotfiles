# Bug fix

1. Reproduce at the observable boundary; record the trigger and expected versus actual result. Reduce the case while preserving the same failure. If blocked, say why.
2. State the suspected mechanism and its predicted result. Choose a safe experiment that distinguishes plausible causes; trace the evidence and inspect other paths with the same mechanism.
3. Add a regression test at the observable boundary when meaningful. Where practical, confirm it fails for the reported defect, not setup or an unrelated error. Correct the mechanism and restore the invariant across affected paths.
4. Re-run the original reproduction and relevant checks. Review the diff; label mitigations, uncertain causality, and unverified scenarios.
