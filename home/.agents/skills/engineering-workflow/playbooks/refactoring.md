# Refactoring

1. Recover intended contracts, actual consumer behavior, persisted data, and coverage. Characterize unclear behavior before restructuring; characterization describes what happens, not what is correct.
2. Compare distinct structures for consequential choices. Hide decisions and group responsibilities that change together; consolidate shared rules, not coincidentally similar code. Prefer less caller burden and localized change over fewer lines.
3. Separate intentional behavior corrections from structural changes. Work in small increments with relevant checks passing; update callers. For compatibility transitions, define completion and removal conditions; remove superseded paths when those conditions hold.
4. Compare old and new behavior at public boundaries, including failures and required compatibility. Use `end-state-refactor` if available for a final architecture pass.
