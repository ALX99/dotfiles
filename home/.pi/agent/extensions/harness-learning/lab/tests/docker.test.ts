import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { runPromise } from "../../../_shared/effect-runtime.ts";
import { openDockerSandbox } from "../docker.ts";
import type { DockerCommand, DockerOutput, DockerRunner } from "../docker-process.ts";
import { LabError } from "../schema.ts";
import { config } from "./fixtures.ts";

function fakeDocker() {
	const calls: DockerCommand[] = [];
	const containers = new Map<
		string,
		{
			Image: string;
			Config: { User: string; WorkingDir: string; Volumes: Record<string, unknown> | null };
			HostConfig: {
				NetworkMode: string;
				Binds: string[] | null;
				Privileged: boolean;
				ReadonlyRootfs: boolean;
				PidMode: string;
				IpcMode: string;
				CgroupnsMode: string;
				CapAdd: string[] | null;
				CapDrop: string[];
				SecurityOpt: string[];
				Memory: number;
				MemorySwap: number;
				NanoCpus: number;
				PidsLimit: number;
				Tmpfs: Record<string, string>;
			};
			Mounts: { Type: string; Destination: string }[];
		}
	>();
	let volumes: Record<string, unknown> | null = null;
	let mutate: ((container: ReturnType<typeof containers.get> & object) => void) | undefined;
	let override: ((command: DockerCommand) => DockerOutput | undefined) | undefined;
	const imageId = `sha256:${"b".repeat(64)}`;
	const run: DockerRunner = (command) =>
		Effect.sync(() => {
			calls.push(command);
			const custom = override?.(command);
			if (custom !== undefined) return custom;
			const args = command.args;
			let stdout = "";
			if (args[0] === "image") stdout = JSON.stringify({ Id: imageId, Os: "linux", Config: { Volumes: volumes } });
			else if (args[0] === "create") {
				const flag = (name: string) => args[args.indexOf(name) + 1]!;
				const tmpfs: Record<string, string> = {};
				for (let i = 0; i < args.length; i++)
					if (args[i] === "--tmpfs") {
						const value = args[i + 1]!;
						const colon = value.indexOf(":");
						tmpfs[value.slice(0, colon)] = value.slice(colon + 1);
					}
				const container = {
					Image: imageId,
					Config: { User: flag("--user"), WorkingDir: flag("--workdir"), Volumes: null },
					HostConfig: {
						NetworkMode: flag("--network"),
						Binds: null,
						Privileged: false,
						ReadonlyRootfs: args.includes("--read-only"),
						PidMode: "",
						IpcMode: flag("--ipc"),
						CgroupnsMode: flag("--cgroupns"),
						CapAdd: null,
						CapDrop: [flag("--cap-drop")],
						SecurityOpt: [flag("--security-opt")],
						Memory: Number(flag("--memory")),
						MemorySwap: Number(flag("--memory-swap")),
						NanoCpus: Number(flag("--cpus")) * 1_000_000_000,
						PidsLimit: Number(flag("--pids-limit")),
						Tmpfs: tmpfs,
					},
					Mounts: [],
				};
				containers.set(flag("--name"), container);
				stdout = "container-id";
			} else if (args[0] === "inspect") {
				const container = containers.get(args.at(-1)!)!;
				mutate?.(container);
				stdout = JSON.stringify(container);
			} else if (args[0] === "exec") {
				if (args.at(-1) === "process.versions.node") stdout = "26.10.0\n";
				else if (command.stdin?.includes('"operation":"export"'))
					stdout = '[{"path":"src/input.mjs","content":"export const value = 1;\\n"}]';
				else stdout = "ok";
			}
			return { stdout, stderr: "", exitCode: 0 };
		});
	return {
		run,
		calls,
		setVolumes: (next: typeof volumes) => {
			volumes = next;
		},
		setMutation: (next: typeof mutate) => {
			mutate = next;
		},
		setOverride: (next: typeof override) => {
			override = next;
		},
	};
}

test("image preflight refuses tags, missing images, image-declared volumes, and malformed daemon output", async () => {
	const fake = fakeDocker();
	await assert.rejects(runPromise(openDockerSandbox("node:26-alpine", fake.run)), /Invalid sandbox image/);
	assert.equal(fake.calls.length, 0);
	fake.setVolumes({ "/workspace": {} });
	await assert.rejects(runPromise(openDockerSandbox(config().image, fake.run)), /volumes are forbidden/);
	fake.setOverride(() => ({ stdout: "", stderr: "No such image", exitCode: 1 }));
	await assert.rejects(runPromise(openDockerSandbox(config().image, fake.run)), /No such image/);
	fake.setOverride(() => ({ stdout: "not JSON", stderr: "", exitCode: 0 }));
	await assert.rejects(runPromise(openDockerSandbox(config().image, fake.run)), /JSON/);
	assert.equal(fake.calls.filter((call) => call.args[0] === "create").length, 0);
});

test("workspaces use only fixed hardened Docker flags and generated commands stay inside exec argv", async () => {
	const fake = fakeDocker();
	const sandbox = await runPromise(openDockerSandbox(config().image, fake.run));
	const argv = ["sh", "-c", "echo 'not a host command'"];
	await runPromise(
		sandbox.withWorkspace(config().suite.tasks[0]!.files, (workspace) =>
			Effect.gen(function* () {
				const output = yield* workspace.call({ type: "toolCall", id: "call", name: "exec", arguments: { argv } });
				assert.equal(output.isError, false);
				yield* workspace.export(["src/input.mjs"]);
			}),
		),
	);
	const create = fake.calls.find((call) => call.args[0] === "create")!;
	assert.ok(create.args.includes("--read-only"));
	assert.equal(create.args[create.args.indexOf("--pull") + 1], "never");
	assert.equal(create.args[create.args.indexOf("--network") + 1], "none");
	for (const forbidden of [
		"--volume",
		"-v",
		"--mount",
		"--publish",
		"--privileged",
		"--env",
		"--env-file",
		"--use-api-socket",
	])
		assert.equal(create.args.includes(forbidden), false);
	const exec = fake.calls.find((call) => call.args.includes("not a host command") || call.args.includes(argv[2]!))!;
	assert.equal(exec.args[0], "exec");
	assert.deepEqual(exec.args.slice(-3), argv);
	assert.ok(fake.calls.at(-1)!.args.includes("--force"));
	assert.equal(fake.calls.at(-1)!.args[0], "rm");
});

test("actual container inspection fails closed on weakened policy and always removes the container", async () => {
	for (const weakness of ["network", "bind", "root", "caps", "memory", "mount", "tmpfs", "image"] as const) {
		const fake = fakeDocker();
		fake.setMutation((container) => {
			if (weakness === "network") container.HostConfig.NetworkMode = "host";
			if (weakness === "bind") container.HostConfig.Binds = ["/:/host"];
			if (weakness === "root") container.Config.User = "0:0";
			if (weakness === "caps") container.HostConfig.CapAdd = ["SYS_ADMIN"];
			if (weakness === "memory") container.HostConfig.Memory = 0;
			if (weakness === "mount") container.Mounts = [{ Type: "bind", Destination: "/host" }];
			if (weakness === "tmpfs") container.HostConfig.Tmpfs["/extra"] = "rw";
			if (weakness === "image") container.Image = "other";
		});
		const sandbox = await runPromise(openDockerSandbox(config().image, fake.run));
		await assert.rejects(
			runPromise(sandbox.withWorkspace(config().suite.tasks[0]!.files, () => Effect.void)),
			/containment|unexpected/,
		);
		assert.equal(
			fake.calls.some((call) => call.args[0] === "start"),
			false,
		);
		assert.equal(fake.calls.at(-1)!.args[0], "rm");
	}
});

test("exports reject unlisted paths and malformed artifacts rather than touching host files", async () => {
	const fake = fakeDocker();
	const sandbox = await runPromise(openDockerSandbox(config().image, fake.run));
	for (const output of [
		'[{"path":"other.mjs","content":"wrong"}]',
		'[{"path":"../escape","content":"wrong"}]',
		'"not artifacts"',
	]) {
		fake.setOverride((command) =>
			command.stdin?.includes('"operation":"export"') ? { stdout: output, stderr: "", exitCode: 0 } : undefined,
		);
		await assert.rejects(
			runPromise(
				sandbox.withWorkspace(config().suite.tasks[0]!.files, (workspace) => workspace.export(["src/input.mjs"])),
			),
			/unlisted|Invalid exported/,
		);
		assert.equal(fake.calls.at(-1)!.args[0], "rm");
	}
});

test("tool boundaries reject absolute/traversal paths, unknown fields, and unknown tools before Docker execution", async () => {
	const fake = fakeDocker();
	const sandbox = await runPromise(openDockerSandbox(config().image, fake.run));
	await assert.rejects(runPromise(sandbox.withWorkspace([{ path: "../escape", content: "bad" }], () => Effect.void)));
	assert.equal(
		fake.calls.some((call) => call.args[0] === "create"),
		false,
	);
	await runPromise(
		sandbox.withWorkspace(config().suite.tasks[0]!.files, (workspace) =>
			Effect.gen(function* () {
				for (const [name, arguments_] of [
					["read", { path: "/etc/passwd" }],
					["read", { path: "src/../escape" }],
					["write", { path: "src/input.mjs", content: "ok", secret: "no" }],
					["exec", { argv: [] }],
					["bash", { command: "pwd" }],
				] as const) {
					const before = fake.calls.length;
					const result = yield* workspace.call({ type: "toolCall", id: "call", name, arguments: arguments_ });
					assert.equal(result.isError, true);
					assert.equal(fake.calls.length, before);
				}
			}),
		),
	);
});

test("verifier signals and command-launch failures are invalid environments, not measured task failures", async () => {
	for (const exitCode of [125, 126, 127, 137]) {
		const fake = fakeDocker();
		fake.setOverride((command) =>
			command.args.includes("/verify/test.mjs") ? { exitCode, stdout: "", stderr: "terminated" } : undefined,
		);
		const sandbox = await runPromise(openDockerSandbox(config().image, fake.run));
		await assert.rejects(
			runPromise(sandbox.verify(config().suite.tasks[0]!, [])),
			/could not execute or was terminated/,
		);
		assert.equal(fake.calls.at(-1)!.args[0], "rm");
	}
});

test("verification receives only trusted fixtures and listed artifacts in a new, read-only verifier workspace", async () => {
	const fake = fakeDocker();
	const sandbox = await runPromise(openDockerSandbox(config().image, fake.run));
	const task = config().suite.tasks[0]!;
	task.verify.files[0]!.content = "HIDDEN INDEPENDENT VERIFIER";
	const artifacts = await runPromise(
		sandbox.withWorkspace(task.files, (workspace) => workspace.export(task.solutionPaths)),
	);
	const result = await runPromise(sandbox.verify(task, artifacts));
	assert.equal(result.verificationExitCode, 0);
	const seeds = fake.calls.filter((call) => call.stdin?.includes('"operation":"seed"'));
	assert.equal(seeds.length, 2);
	assert.equal(seeds[0]!.stdin!.includes("HIDDEN"), false);
	assert.ok(seeds[1]!.stdin!.includes("HIDDEN"));
	assert.ok(seeds[1]!.stdin!.includes('"readonly":true'));
	const creates = fake.calls.filter((call) => call.args[0] === "create");
	assert.equal(creates.length, 2);
	assert.notEqual(
		creates[0]!.args[creates[0]!.args.indexOf("--name") + 1],
		creates[1]!.args[creates[1]!.args.indexOf("--name") + 1],
	);
	assert.equal(seeds[1]!.args[seeds[1]!.args.indexOf("--user") + 1], "0:0");
	const verify = fake.calls.find((call) => call.args.includes("/verify/test.mjs"))!;
	assert.equal(verify.args[verify.args.indexOf("--user") + 1], "65534:65534");
	assert.equal(fake.calls.at(-1)!.args[0], "rm");
});

test("workspace failure, interrupted creation, and cancellation all run daemon-side removal", async () => {
	const fake = fakeDocker();
	const sandbox = await runPromise(openDockerSandbox(config().image, fake.run));
	await assert.rejects(
		runPromise(
			sandbox.withWorkspace(config().suite.tasks[0]!.files, () =>
				Effect.fail(new LabError({ message: "task failed" })),
			),
		),
		/task failed/,
	);
	assert.equal(fake.calls.at(-1)!.args[0], "rm");
	const controller = new AbortController();
	await assert.rejects(
		runPromise(
			sandbox.withWorkspace(config().suite.tasks[0]!.files, () =>
				Effect.sync(() => controller.abort()).pipe(Effect.andThen(Effect.never)),
			),
			{ signal: controller.signal },
		),
	);
	assert.equal(fake.calls.at(-1)!.args[0], "rm");
	const calls: DockerCommand[] = [];
	const interrupted: DockerRunner = (command) => {
		calls.push(command);
		if (command.args[0] === "create") return Effect.interrupt;
		return fake.run(command);
	};
	const other = await runPromise(openDockerSandbox(config().image, interrupted));
	await assert.rejects(runPromise(other.withWorkspace(config().suite.tasks[0]!.files, () => Effect.void)));
	assert.equal(calls.at(-1)!.args[0], "rm");
});
