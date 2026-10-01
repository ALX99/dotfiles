import { randomUUID } from "node:crypto";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Effect, Result, Schema } from "effect";
import { Type } from "typebox";
import { parseJson } from "../../_shared/json.ts";
import { CONTAINER_FILE_PROGRAM } from "./container-program.ts";
import { runDockerCommand, type DockerOutput, type DockerRunner } from "./docker-process.ts";
import {
	LabArtifactsSchema,
	LabConfigSchema,
	LabError,
	LabFilePathSchema,
	LabTaskSchema,
	MAX_TASK_FILES_BYTES,
	MAX_TASK_FILE_CHARS,
	MAX_VERIFICATION_OUTPUT_CHARS,
	type LabTask,
	type LabTaskOutcome,
} from "./schema.ts";

type Artifacts = typeof LabArtifactsSchema.Type;
type Verification = Pick<
	Extract<LabTaskOutcome, { status: "completed" }>,
	"verificationExitCode" | "verificationOutput"
>;
export interface LabToolOutput {
	readonly text: string;
	readonly isError: boolean;
}
export interface LabWorkspace {
	call(tool: ToolCall): Effect.Effect<LabToolOutput, LabError>;
	export(paths: LabTask["solutionPaths"]): Effect.Effect<Artifacts, LabError>;
}
export interface LabSandbox {
	withWorkspace<A, E>(
		files: LabTask["files"],
		use: (workspace: LabWorkspace) => Effect.Effect<A, E>,
	): Effect.Effect<A, E | LabError>;
	verify(task: LabTask, artifacts: Artifacts): Effect.Effect<Verification, LabError>;
}

const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const ENV_COMMAND = ["/usr/bin/env", "-i", "--", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp"];
const WORKSPACE_TMPFS = "rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65534,gid=65534";
const VERIFY_WORKSPACE_TMPFS = "rw,nosuid,nodev,noexec,size=16m,mode=0755,uid=0,gid=0";
const VERIFY_TMPFS = "rw,nosuid,nodev,noexec,size=16m,mode=0755,uid=0,gid=0";
const TMP_TMPFS = "rw,nosuid,nodev,noexec,size=8m,mode=0700,uid=65534,gid=65534";
const MEMORY_BYTES = 256 * 1024 * 1024;
const stringList = Schema.Array(Schema.String);
const optionalList = Schema.NullOr(stringList);
const volumes = Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown));
const decodeImage = Schema.decodeUnknownEffect(
	Schema.Struct({
		Id: Schema.String,
		Os: Schema.Literal("linux"),
		Config: Schema.Struct({ Volumes: Schema.optional(volumes) }),
	}).check(
		Schema.makeFilter((image) =>
			Object.keys(image.Config.Volumes ?? {}).length === 0 ? undefined : "image-declared volumes are forbidden",
		),
	),
	{ onExcessProperty: "ignore" },
);
const decodeContainer = Schema.decodeUnknownEffect(
	Schema.Struct({
		Image: Schema.String,
		Config: Schema.Struct({
			User: Schema.Literal("65534:65534"),
			WorkingDir: Schema.Literal("/workspace"),
			Volumes: Schema.optional(volumes),
		}),
		HostConfig: Schema.Struct({
			NetworkMode: Schema.Literal("none"),
			Binds: optionalList,
			Privileged: Schema.Literal(false),
			ReadonlyRootfs: Schema.Literal(true),
			PidMode: Schema.Literal(""),
			IpcMode: Schema.Literal("none"),
			CgroupnsMode: Schema.Literal("private"),
			CapAdd: optionalList,
			CapDrop: stringList,
			SecurityOpt: stringList,
			Memory: Schema.Literal(MEMORY_BYTES),
			MemorySwap: Schema.Literal(MEMORY_BYTES),
			NanoCpus: Schema.Literal(1_000_000_000),
			PidsLimit: Schema.Literal(64),
			Tmpfs: Schema.Record(Schema.String, Schema.String),
		}),
		Mounts: Schema.Array(Schema.Struct({ Type: Schema.Literal("tmpfs"), Destination: Schema.String })),
	}).check(
		Schema.makeFilter((container) =>
			(container.HostConfig.Binds?.length ?? 0) === 0 &&
			(container.HostConfig.CapAdd?.length ?? 0) === 0 &&
			Object.keys(container.Config.Volumes ?? {}).length === 0 &&
			container.HostConfig.CapDrop.includes("ALL") &&
			container.HostConfig.SecurityOpt.some((option) => /^no-new-privileges(?::|=true)?$/.test(option))
				? undefined
				: "container has unexpected mounts, capabilities, or privilege policy",
		),
	),
	{ onExcessProperty: "ignore" },
);
const decodeRead = Schema.decodeUnknownResult(Schema.Struct({ path: LabFilePathSchema }), {
	onExcessProperty: "error",
});
const decodeWrite = Schema.decodeUnknownResult(
	Schema.Struct({ path: LabFilePathSchema, content: Schema.String.check(Schema.isMaxLength(MAX_TASK_FILE_CHARS)) }),
	{ onExcessProperty: "error" },
);
const decodeExec = Schema.decodeUnknownResult(
	Schema.Struct({
		argv: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))).check(
			Schema.isMinLength(1),
			Schema.isMaxLength(16),
		),
	}),
	{ onExcessProperty: "error" },
);

export const LAB_CODING_TOOLS: Tool[] = [
	{
		name: "read",
		description: "Read a bounded UTF-8 regular file under /workspace. Use a relative path; links are refused.",
		parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
	},
	{
		name: "write",
		description: "Create or replace a UTF-8 file under /workspace. Use a relative path; links are refused.",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }),
	},
	{
		name: "exec",
		description:
			"Run argv inside the isolated workspace, without a shell unless you explicitly request one. Network is unavailable.",
		parameters: Type.Object({ argv: Type.Array(Type.String()) }, { additionalProperties: false }),
	},
];

const parsedJson = Effect.fnUntraced(function* (output: DockerOutput) {
	if (output.exitCode !== 0)
		return yield* new LabError({
			message: `Docker control command failed (${output.exitCode}): ${output.stderr.slice(0, 1000)}`,
		});
	return yield* Effect.fromResult(parseJson(output.stdout, "Docker response")).pipe(
		Effect.mapError((error) => new LabError({ message: error.message })),
	);
});
const commandOk = Effect.fnUntraced(function* (output: DockerOutput) {
	if (output.exitCode !== 0)
		return yield* new LabError({
			message: `Docker control command failed (${output.exitCode}): ${output.stderr.slice(0, 1000)}`,
		});
	return output;
});

/** Digest-pinned, already-local images only. The daemon and image are trusted infrastructure. */
export const openDockerSandbox = Effect.fn("harnessLearning.openDockerSandbox")(function* (
	image: string,
	run: DockerRunner = runDockerCommand,
): Effect.fn.Return<LabSandbox, LabError> {
	yield* Schema.decodeUnknownEffect(LabConfigSchema.fields.image)(image).pipe(
		Effect.mapError((error) => new LabError({ message: `Invalid sandbox image: ${error.message}` })),
	);
	const inspected = yield* run({
		args: ["image", "inspect", "--format", "{{json .}}", image],
		timeoutMs: COMMAND_TIMEOUT_MS,
		maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
	}).pipe(Effect.flatMap(parsedJson));
	const checkedImage = yield* decodeImage(inspected).pipe(
		Effect.mapError((error) => new LabError({ message: `Sandbox image refused: ${error.message}` })),
	);

	function inContainer<A, E>(
		verification: boolean,
		use: (name: string) => Effect.Effect<A, E>,
	): Effect.Effect<A, E | LabError> {
		return Effect.scoped(
			Effect.gen(function* () {
				const name = `pi-harness-lab-${randomUUID()}`;
				// Register removal before create: a cancelled CLI can leave a daemon-side container behind.
				yield* Effect.addFinalizer(() =>
					run({ args: ["rm", "--force", "--volumes", name], timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: 4096 }).pipe(
						Effect.flatMap((output) =>
							output.exitCode !== 0 && /No such container:/i.test(output.stderr)
								? Effect.succeed(output)
								: commandOk(output),
						),
						Effect.orDie,
					),
				);
				const tmpfs: Record<string, string> = {
					"/workspace": verification ? VERIFY_WORKSPACE_TMPFS : WORKSPACE_TMPFS,
					"/tmp": TMP_TMPFS,
				};
				if (verification) tmpfs["/verify"] = VERIFY_TMPFS;
				const args = [
					"create",
					"--name",
					name,
					"--label",
					"pi.harness-learning.lab=true",
					"--pull",
					"never",
					"--network",
					"none",
					"--read-only",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges=true",
					"--user",
					"65534:65534",
					"--pids-limit",
					"64",
					"--memory",
					String(MEMORY_BYTES),
					"--memory-swap",
					String(MEMORY_BYTES),
					"--cpus",
					"1",
					"--ipc",
					"none",
					"--cgroupns",
					"private",
					"--log-driver",
					"none",
					"--restart",
					"no",
					"--no-healthcheck",
					"--init",
					"--workdir",
					"/workspace",
					...Object.entries(tmpfs).flatMap(([path, options]) => ["--tmpfs", `${path}:${options}`]),
					"--entrypoint",
					ENV_COMMAND[0]!,
					image,
					...ENV_COMMAND.slice(1),
					"node",
					"-e",
					"setInterval(() => {}, 1000)",
				];
				yield* run({ args, timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: 4096 }).pipe(
					Effect.flatMap(commandOk),
					Effect.uninterruptible,
				);
				const raw = yield* run({
					args: ["inspect", "--format", "{{json .}}", name],
					timeoutMs: COMMAND_TIMEOUT_MS,
					maxOutputBytes: MAX_TOOL_OUTPUT_BYTES,
				}).pipe(Effect.flatMap(parsedJson));
				const container = yield* decodeContainer(raw).pipe(
					Effect.mapError((error) => new LabError({ message: `Sandbox containment refused: ${error.message}` })),
				);
				if (
					container.Image !== checkedImage.Id ||
					Object.keys(container.HostConfig.Tmpfs).length !== Object.keys(tmpfs).length ||
					Object.entries(tmpfs).some(([path, options]) => container.HostConfig.Tmpfs[path] !== options) ||
					container.Mounts.some((mount) => !Object.hasOwn(tmpfs, mount.Destination))
				)
					return yield* new LabError({ message: "Sandbox has an unexpected image or tmpfs layout" });
				yield* run({ args: ["start", name], timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: 4096 }).pipe(
					Effect.flatMap(commandOk),
				);
				const version = yield* execute(name, ["node", "-p", "process.versions.node"], undefined, 256).pipe(
					Effect.flatMap(commandOk),
				);
				yield* Schema.decodeUnknownEffect(
					Schema.String.check(
						Schema.isPattern(/^\d+\.\d+\.\d+\s*$/),
						Schema.makeFilter((value) =>
							Number(value.split(".")[0]) >= 26 ? undefined : "Node 26 or newer is required",
						),
					),
				)(version.stdout).pipe(Effect.mapError((error) => new LabError({ message: error.message })));
				return yield* use(name);
			}),
		);
	}

	function execute(
		name: string,
		argv: readonly string[],
		stdin?: string,
		maxOutputBytes = MAX_TOOL_OUTPUT_BYTES,
		root = false,
	) {
		return run({
			args: [
				"exec",
				"-i",
				"--user",
				root ? "0:0" : "65534:65534",
				"--workdir",
				"/workspace",
				name,
				...ENV_COMMAND,
				...argv,
			],
			...(stdin === undefined ? {} : { stdin }),
			timeoutMs: COMMAND_TIMEOUT_MS,
			maxOutputBytes,
		});
	}

	function fileOperation(name: string, input: unknown, maxOutputBytes?: number, root = false) {
		return execute(name, ["node", "-e", CONTAINER_FILE_PROGRAM], JSON.stringify(input), maxOutputBytes, root);
	}

	return {
		withWorkspace: (files, use) =>
			Effect.gen(function* () {
				const checkedFiles = yield* Schema.decodeUnknownEffect(LabTaskSchema.fields.files, {
					onExcessProperty: "error",
				})(files).pipe(Effect.mapError((error) => new LabError({ message: error.message })));
				return yield* inContainer(false, (name) =>
					Effect.gen(function* () {
						yield* fileOperation(name, { operation: "seed", files: checkedFiles, readonly: false }).pipe(
							Effect.flatMap(commandOk),
						);
						const call = Effect.fnUntraced(function* (tool: ToolCall): Effect.fn.Return<LabToolOutput, LabError> {
							let output: DockerOutput;
							if (tool.name === "exec") {
								const args = decodeExec(tool.arguments);
								if (Result.isFailure(args)) return { text: args.failure.message, isError: true };
								output = yield* execute(name, args.success.argv);
							} else if (tool.name === "read" || tool.name === "write") {
								const args = tool.name === "read" ? decodeRead(tool.arguments) : decodeWrite(tool.arguments);
								if (Result.isFailure(args)) return { text: args.failure.message, isError: true };
								output = yield* fileOperation(name, { operation: tool.name, ...args.success });
							} else return { text: `Unknown sandbox tool: ${tool.name}`, isError: true };
							return {
								text: `Exit ${output.exitCode}\n${output.stdout}${output.stderr}`,
								isError: output.exitCode !== 0,
							};
						});
						const exportFiles = Effect.fnUntraced(function* (paths: LabTask["solutionPaths"]) {
							yield* Schema.decodeUnknownEffect(LabTaskSchema.fields.solutionPaths)(paths).pipe(
								Effect.mapError((error) => new LabError({ message: error.message })),
							);
							const raw = yield* fileOperation(
								name,
								{ operation: "export", paths },
								MAX_TASK_FILES_BYTES * 6 + 4096,
							).pipe(Effect.flatMap(parsedJson));
							const artifacts = yield* Schema.decodeUnknownEffect(LabArtifactsSchema, { onExcessProperty: "error" })(
								raw,
							).pipe(
								Effect.mapError((error) => new LabError({ message: `Invalid exported artifacts: ${error.message}` })),
							);
							if (artifacts.some((file) => !paths.includes(file.path)))
								return yield* new LabError({ message: "Export returned an unlisted solution file" });
							return artifacts;
						});
						return yield* use({ call, export: exportFiles });
					}),
				);
			}),
		verify: (task, artifacts) =>
			inContainer(true, (name) =>
				Effect.gen(function* () {
					yield* Schema.decodeUnknownEffect(LabTaskSchema, { onExcessProperty: "error" })(task).pipe(
						Effect.mapError((error) => new LabError({ message: error.message })),
					);
					yield* Schema.decodeUnknownEffect(LabArtifactsSchema, { onExcessProperty: "error" })(artifacts).pipe(
						Effect.mapError((error) => new LabError({ message: error.message })),
					);
					if (artifacts.some((file) => !task.solutionPaths.includes(file.path)))
						return yield* new LabError({ message: "Verification received an unlisted solution file" });
					const artifactPaths = new Set(artifacts.map((file) => file.path));
					const files = [...task.files.filter((file) => !artifactPaths.has(file.path)), ...artifacts];
					yield* fileOperation(
						name,
						{ operation: "seed", files, verify: task.verify.files, readonly: true },
						undefined,
						true,
					).pipe(Effect.flatMap(commandOk));
					const result = yield* execute(name, task.verify.argv, undefined, MAX_VERIFICATION_OUTPUT_CHARS);
					if (result.exitCode < 0 || result.exitCode > 255)
						return yield* new LabError({ message: "Verifier returned an invalid exit status" });
					if (result.exitCode >= 125)
						return yield* new LabError({
							message: `Verifier could not execute or was terminated (${result.exitCode})`,
						});
					return { verificationExitCode: result.exitCode, verificationOutput: result.stdout + result.stderr };
				}),
			),
	};
});
