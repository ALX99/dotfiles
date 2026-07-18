import assert from "node:assert/strict";
import test from "node:test";

import { CaffeinateController, type CaffeinateProcess } from "../caffeinate.ts";

function createProcess(): {
	readonly child: CaffeinateProcess;
	readonly emitError: (error: Error) => void;
	readonly emitExit: () => void;
	readonly kills: () => number;
} {
	let errorListener: ((error: Error) => void) | undefined;
	let exitListener: (() => void) | undefined;
	let killCount = 0;
	return {
		child: {
			kill() {
				killCount += 1;
				return true;
			},
			once(event, listener) {
				if (event === "error") errorListener = listener;
				else exitListener = listener;
			},
		},
		emitError(error) {
			errorListener?.(error);
		},
		emitExit() {
			exitListener?.();
		},
		kills: () => killCount,
	};
}

test("caffeinate is a no-op outside macOS", () => {
	let spawns = 0;
	const controller = new CaffeinateController({
		platform: "linux",
		pid: 42,
		spawn() {
			spawns += 1;
			return createProcess().child;
		},
		onError() {
			assert.fail("unsupported platforms must not report process errors");
		},
	});

	controller.start();
	controller.stop();
	assert.equal(spawns, 0);
});

test("caffeinate observes spawn errors and permits a later restart", () => {
	const first = createProcess();
	const second = createProcess();
	const errors: Error[] = [];
	let spawns = 0;
	const controller = new CaffeinateController({
		platform: "darwin",
		pid: 42,
		spawn() {
			spawns += 1;
			return spawns === 1 ? first.child : second.child;
		},
		onError(error) {
			errors.push(error);
		},
	});

	controller.start();
	first.emitError(new Error("missing caffeinate"));
	controller.start();

	assert.equal(spawns, 2);
	assert.deepEqual(
		errors.map((error) => error.message),
		["missing caffeinate"],
	);
});

test("caffeinate stop is idempotent after exit or repeated cleanup", () => {
	const process = createProcess();
	const controller = new CaffeinateController({
		platform: "darwin",
		pid: 42,
		spawn: () => process.child,
		onError() {},
	});

	controller.start();
	controller.stop();
	controller.stop();
	assert.equal(process.kills(), 1);

	controller.start();
	process.emitExit();
	controller.stop();
	assert.equal(process.kills(), 1);
});
