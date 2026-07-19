import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { ByteBoundedJsonlFramer } from "../jsonl.ts";

test("JSONL framing is invariant across arbitrary byte chunk boundaries", () => {
	fc.assert(
		fc.property(
			fc.array(fc.jsonValue(), { maxLength: 30 }),
			fc.array(fc.integer({ min: 1, max: 32 }), { minLength: 1, maxLength: 30 }),
			(records, chunkSizes) => {
				const expected = records.map((record) => JSON.stringify(record));
				const bytes = Buffer.from(expected.map((line) => `${line}\n`).join(""), "utf8");
				const framer = new ByteBoundedJsonlFramer(1024 * 1024);
				const actual: string[] = [];
				let offset = 0;
				let chunkIndex = 0;
				while (offset < bytes.byteLength) {
					const size = chunkSizes[chunkIndex++ % chunkSizes.length]!;
					actual.push(...framer.push(bytes.subarray(offset, offset + size)));
					offset += size;
				}
				actual.push(...framer.end());
				assert.deepEqual(actual, expected);
			},
		),
	);
});

test("JSONL framing enforces its limit on UTF-8 bytes, not characters", () => {
	fc.assert(
		fc.property(fc.string(), (value) => {
			const frame = Buffer.from(JSON.stringify({ value }), "utf8");
			const exact = new ByteBoundedJsonlFramer(frame.byteLength);
			assert.deepEqual(exact.push(Buffer.concat([frame, Buffer.from("\n")])), [frame.toString("utf8")]);

			if (frame.byteLength > 0) {
				const tooSmall = new ByteBoundedJsonlFramer(frame.byteLength - 1);
				assert.throws(() => tooSmall.push(frame), /frame exceeds/);
			}
		}),
	);
});
