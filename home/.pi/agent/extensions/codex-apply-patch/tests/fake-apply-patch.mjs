#!/usr/bin/env node

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

if (input === "FAIL") {
	process.stdout.write("upstream stdout\n");
	process.stderr.write("upstream stderr\n");
	process.exitCode = 7;
} else if (input === "LARGE_FAILURE") {
	process.stdout.write("o".repeat(128 * 1024));
	process.stderr.write("e".repeat(128 * 1024));
	process.exitCode = 9;
} else if (input === "HANG") {
	process.stdout.write("started\n");
	setInterval(() => undefined, 10_000);
} else {
	process.stdout.write(
		JSON.stringify({
			input,
			cwd: process.cwd(),
			args: process.argv.slice(2),
		}),
	);
}
