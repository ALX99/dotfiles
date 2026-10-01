import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { runPromise } from "../../../_shared/effect-runtime.ts";
import { openDockerSandbox } from "../docker.ts";
import { runDockerCommand, type DockerCommand, type DockerRunner } from "../docker-process.ts";
import { executeLabTask } from "../executor.ts";
import { loadLabStore } from "../store.ts";
import { config, startedDocument } from "./fixtures.ts";
import { response, fakeModels, runtimeStore } from "./runtime-fixtures.ts";

// Explicit opt-in: these tests never pull an image or start a stopped Docker daemon.
const image = process.env.HARNESS_LAB_TEST_IMAGE;
const options = {
	skip: image === undefined ? "Set HARNESS_LAB_TEST_IMAGE to an already-local digest-pinned Node 26+ image" : false,
};

function recordedDocker() {
	const names: string[] = [];
	const commands: DockerCommand[] = [];
	const run: DockerRunner = (command) => {
		commands.push(command);
		if (command.args[0] === "create") names.push(command.args[command.args.indexOf("--name") + 1]!);
		return runDockerCommand(command);
	};
	const assertRemoved = async () => {
		for (const name of names) {
			const result = await runPromise(
				runDockerCommand({
					args: ["inspect", "--format", "{{json .}}", name],
					timeoutMs: 5000,
					maxOutputBytes: 4096,
				}),
			);
			assert.notEqual(result.exitCode, 0);
			assert.match(result.stderr, /no such (object|container)/i);
		}
	};
	return { run, names, commands, assertRemoved };
}

test(
	"real Docker: agent tools, credential-free nonroot execution, exact export, and fresh trusted verification",
	options,
	async (t) => {
		const docker = recordedDocker();
		t.after(docker.assertRemoved);
		const sandbox = await runPromise(openDockerSandbox(image!, docker.run));
		const task = config().suite.tasks[0]!;
		task.verify.files[0]!.content =
			"import assert from 'node:assert/strict'; import fs from 'node:fs'; " +
			"import { value } from '/workspace/src/input.mjs'; " +
			"assert.equal(value, 2); assert.equal(fs.existsSync('/workspace/agent-marker'), false); " +
			"assert.throws(() => fs.writeFileSync('/verify/test.mjs', 'forged')); console.log('trusted verification passed');";
		const artifacts = await runPromise(
			sandbox.withWorkspace(task.files, (workspace) =>
				Effect.gen(function* () {
					const hidden = yield* workspace.call({
						type: "toolCall",
						id: "hidden",
						name: "exec",
						arguments: {
							argv: ["node", "-e", "process.stdout.write(String(require('node:fs').existsSync('/verify/test.mjs')))"],
						},
					});
					assert.equal(hidden.text, "Exit 0\nfalse");
					const environment = yield* workspace.call({
						type: "toolCall",
						id: "env",
						name: "exec",
						arguments: {
							argv: [
								"node",
								"-e",
								"console.log(JSON.stringify({uid:process.getuid(), env:process.env, interfaces:Object.keys(require('node:os').networkInterfaces())}))",
							],
						},
					});
					assert.equal(environment.isError, false);
					const parsed = JSON.parse(environment.text.slice("Exit 0\n".length)) as {
						uid: number;
						env: Record<string, string>;
						interfaces: string[];
					};
					assert.equal(parsed.uid, 65534);
					assert.deepEqual(Object.keys(parsed.env).toSorted(), ["HOME", "PATH"]);
					assert.deepEqual(parsed.interfaces, ["lo"]);
					assert.equal(
						(yield* workspace.call({
							type: "toolCall",
							id: "write",
							name: "write",
							arguments: { path: "src/input.mjs", content: "export const value = 2;\n" },
						})).isError,
						false,
					);
					yield* workspace.call({
						type: "toolCall",
						id: "marker",
						name: "write",
						arguments: { path: "agent-marker", content: "must not cross into verification" },
					});
					const read = yield* workspace.call({
						type: "toolCall",
						id: "read",
						name: "read",
						arguments: { path: "src/input.mjs" },
					});
					assert.equal(read.text, "Exit 0\nexport const value = 2;\n");
					return yield* workspace.export(task.solutionPaths);
				}),
			),
		);
		assert.deepEqual(artifacts, [{ path: "src/input.mjs", content: "export const value = 2;\n" }]);
		const result = await runPromise(sandbox.verify(task, artifacts));
		assert.equal(result.verificationExitCode, 0);
		assert.match(result.verificationOutput, /trusted verification passed/);
		assert.equal(docker.names.length, 2);
		assert.notEqual(docker.names[0], docker.names[1]);
		await docker.assertRemoved();
	},
);

test(
	"real Docker: exports refuse symlinks, linked parents, hard links, FIFOs, binary data, and excessive text",
	options,
	async (t) => {
		const docker = recordedDocker();
		t.after(docker.assertRemoved);
		const sandbox = await runPromise(openDockerSandbox(image!, docker.run));
		const cases = [
			"fs.unlinkSync('src/input.mjs'); fs.symlinkSync('/etc/passwd','src/input.mjs');",
			"fs.renameSync('src','old'); fs.symlinkSync('/etc','src');",
			"fs.linkSync('src/input.mjs','hardlink');",
			"fs.unlinkSync('src/input.mjs'); require('node:child_process').execFileSync('mkfifo',['src/input.mjs']);",
			"fs.writeFileSync('src/input.mjs',Buffer.from([255]));",
			"fs.writeFileSync('src/input.mjs','x'.repeat(16385));",
		];
		for (const command of cases) {
			await assert.rejects(
				runPromise(
					sandbox.withWorkspace(config().suite.tasks[0]!.files, (workspace) =>
						Effect.gen(function* () {
							const result = yield* workspace.call({
								type: "toolCall",
								id: "corrupt",
								name: "exec",
								arguments: { argv: ["node", "-e", `const fs=require('node:fs'); ${command}`] },
							});
							assert.equal(result.isError, false);
							return yield* workspace.export(["src/input.mjs"]);
						}),
					),
				),
				/Docker control command failed|Invalid exported/,
			);
		}
		await docker.assertRemoved();
	},
);

test(
	"real Docker: process output limits, task cancellation, and timeouts remove daemon-side descendants",
	options,
	async (t) => {
		const docker = recordedDocker();
		t.after(docker.assertRemoved);
		const sandbox = await runPromise(openDockerSandbox(image!, docker.run));
		await assert.rejects(
			runPromise(
				sandbox.withWorkspace(config().suite.tasks[0]!.files, (workspace) =>
					workspace.call({
						type: "toolCall",
						id: "flood",
						name: "exec",
						arguments: { argv: ["node", "-e", "process.stdout.write('x'.repeat(100000))"] },
					}),
				),
			),
			/output limit/,
		);
		const controller = new AbortController();
		const entered = Promise.withResolvers<void>();
		const pending = runPromise(
			sandbox.withWorkspace(config().suite.tasks[0]!.files, (workspace) =>
				Effect.sync(() => entered.resolve()).pipe(
					Effect.andThen(
						workspace.call({
							type: "toolCall",
							id: "stall",
							name: "exec",
							arguments: { argv: ["node", "-e", "setInterval(()=>{},1000);/*harness-executor-stall*/"] },
						}),
					),
				),
			),
			{ signal: controller.signal },
		);
		const rejected = assert.rejects(pending);
		await entered.promise;
		try {
			let running = false;
			for (let attempt = 0; attempt < 20; attempt++) {
				const processes = await runPromise(
					runDockerCommand({
						args: [
							"exec",
							docker.names.at(-1)!,
							"/usr/bin/env",
							"-i",
							"--",
							"PATH=/usr/local/bin:/usr/bin:/bin",
							"HOME=/tmp",
							"node",
							"-e",
							"const fs=require('node:fs'); console.log(fs.readdirSync('/proc').some(pid=>{if(!/^\\d+$/.test(pid)||Number(pid)===process.pid)return false;try{return fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes('harness-executor-stall')}catch{return false}}));",
						],
						timeoutMs: 2000,
						maxOutputBytes: 8192,
					}),
				);
				assert.equal(processes.exitCode, 0);
				if (processes.stdout.trim() === "true") {
					running = true;
					break;
				}
				await runPromise(Effect.sleep(50));
			}
			assert.equal(running, true, "The task process must be running inside the daemon before cancellation");
		} finally {
			controller.abort();
			await rejected;
		}
		await assert.rejects(
			runPromise(sandbox.withWorkspace(config().suite.tasks[0]!.files, () => Effect.never).pipe(Effect.timeout(1000))),
			/timed out|Timeout/,
		);
		await docker.assertRemoved();
	},
);

test("real Docker: process runner never accepts an oversized or stalled control response", options, async () => {
	await assert.rejects(
		runPromise(
			runDockerCommand({
				args: ["image", "inspect", "--format", "{{json .}}", image!],
				timeoutMs: 5000,
				maxOutputBytes: 1,
			}),
		),
		/output limit/,
	);
	await assert.rejects(
		runPromise(
			runDockerCommand({
				args: ["image", "inspect", "--format", "{{json .}}", image!],
				timeoutMs: 1,
				maxOutputBytes: 65536,
			}),
		),
		/failed|timed out/,
	);
});

test(
	"real Docker: fake-provider coding execution records verified artifacts and bounded request provenance",
	options,
	async (t) => {
		const settings = config();
		settings.image = image!;
		settings.limits.maxTaskTimeMs = 30_000;
		settings.suite.tasks[0]!.verify.files[0]!.content =
			"import assert from 'node:assert/strict'; import {value} from '/workspace/src/input.mjs'; assert.equal(value,2);";
		const store = await runtimeStore(t, startedDocument(settings));
		const docker = recordedDocker();
		t.after(docker.assertRemoved);
		const sandbox = await runPromise(openDockerSandbox(image!, docker.run));
		let turn = 0;
		const models = fakeModels(() => {
			const message = response();
			if (turn++ === 0) {
				message.stopReason = "toolUse";
				message.content = [
					{
						type: "toolCall",
						id: "write",
						name: "write",
						arguments: { path: "src/input.mjs", content: "export const value = 2;" },
					},
				];
			}
			return message;
		});
		const result = await runPromise(
			executeLabTask(store, models.client, sandbox, {
				phase: "seed",
				candidateId: null,
				taskId: "target-0",
				repeat: 0,
				arm: "baseline",
			}),
		);
		assert.equal(result.outcome.status, "completed");
		assert.equal(result.outcome.status === "completed" && result.outcome.verificationExitCode, 0);
		assert.equal(result.requestIds.length, 2);
		const { state } = await runPromise(loadLabStore(store));
		assert.deepEqual(state.tasks, [result]);
		assert.equal(state.requestEnds.length, 2);
		assert.equal(state.head.id, "root");
		assert.equal(docker.names.length, 2);
		await docker.assertRemoved();
	},
);
