# Performance issue

1. Establish a representative workload, environment, metric, baseline, and sample size. Confirm the benchmark exercises the intended work and identify its limiter; track correctness, errors, and resource use.
2. Profile the relevant path. Separate execution from waiting and queueing; estimate the possible end-to-end gain. Prefer eliminating work over adding concurrency; choose by measured payoff and complexity.
3. Change one justified mechanism; compare repeated measurements under matched conditions and check other representative inputs. Preserve correctness, error-rate, and resource guardrails.
4. Report before and after, units, methodology, variability, and limitations. An inconclusive measurement is not a win. For sustained optimization use `hillclimb.md`.
