# Feature

1. Establish user-visible examples and invariants from the request and consumers, independently of the implementation; identify state ownership.
2. Resolve the riskiest uncertainty early. Prefer a thin production-quality end-to-end slice before expanding. For consequential designs, compare a distinct alternative, including reuse, by caller burden and change locality.
3. Convert untrusted inputs into valid internal representations before effects; exclude invalid states where simple. For changed trust boundaries, identify who controls inputs, what they could gain, and where validation and authorization belong.
4. Verify real behavior: required effects and absence of forbidden effects. For stateful behavior, check relevant transitions—partial success, failure, retry, cancellation, recovery—and remaining state. Update affected callers and documentation.
