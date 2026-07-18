import assert from "node:assert/strict";
import test from "node:test";
import { hasNodeErrorCode, toError } from "../errors.ts";

test("toError preserves Errors and converts other thrown values", () => {
	const original = new Error("original");
	assert.equal(toError(original), original);
	assert.equal(toError("failure").message, "failure");
});

test("hasNodeErrorCode narrows only matching Error objects", () => {
	const error = Object.assign(new Error("missing"), { code: "ENOENT" });
	assert.equal(hasNodeErrorCode(error, "ENOENT"), true);
	assert.equal(hasNodeErrorCode(error, "EACCES"), false);
	assert.equal(hasNodeErrorCode({ code: "ENOENT" }, "ENOENT"), false);
});
