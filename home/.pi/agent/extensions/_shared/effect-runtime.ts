import { Effect, type Fiber } from "effect";

/**
 * Run an effect from promise-based extension code, such as an event handler.
 * This and `runFork` are the only bridges between Effect code and Pi's
 * promise and callback API.
 */
export function runPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
	return Effect.runPromise(effect);
}

/**
 * Start a long-lived effect, such as a watchdog, and hand back its fiber.
 * Callers that own the work interrupt the fiber when it is no longer needed.
 */
export function runFork<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> {
	return Effect.runFork(effect);
}
