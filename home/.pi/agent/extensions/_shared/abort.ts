import { addAbortListener } from "node:events";

export interface ComposedAbortSignal {
	readonly signal: AbortSignal;
	readonly timedOut: () => boolean;
}

/** Combine optional caller cancellation with a timeout while retaining its cause. */
export function composeAbortSignal(
	parent: AbortSignal | undefined,
	timeoutMs: number | undefined,
): ComposedAbortSignal | undefined {
	const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
	if (!parent && !timeout) return undefined;
	return {
		signal: parent && timeout ? AbortSignal.any([parent, timeout]) : (parent ?? timeout)!,
		timedOut: () => timeout?.aborted === true,
	};
}

/** Register an abort listener with deterministic, disposable cleanup. */
export function onAbort(signal: AbortSignal, listener: () => void): Disposable {
	return addAbortListener(signal, listener);
}
