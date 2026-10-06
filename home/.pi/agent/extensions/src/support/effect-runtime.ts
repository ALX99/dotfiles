import { Effect, type Fiber } from "effect";

export interface EffectRunner {
	run<A, E>(effect: Effect.Effect<A, E>, options?: { readonly signal?: AbortSignal | undefined }): Promise<A>;
}

/**
 * Run an effect for process-scoped host resources that outlive a session runtime.
 * Session features receive the per-session ApplicationEffects bridge instead.
 */
export function runPromise<A, E>(
	effect: Effect.Effect<A, E>,
	options?: { readonly signal?: AbortSignal | undefined },
): Promise<A> {
	return Effect.runPromise(effect, options);
}

/**
 * Start a process-scoped effect, such as the background-job sweep, and hand back
 * its fiber. Its process-level owner interrupts it during teardown.
 */
export function runFork<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> {
	return Effect.runFork(effect);
}
