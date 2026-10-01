import { NodeServices } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { LabError } from "./schema.ts";

export interface DockerCommand {
	readonly args: readonly string[];
	readonly stdin?: string;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
}

export interface DockerOutput {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export type DockerRunner = (command: DockerCommand) => Effect.Effect<DockerOutput, LabError>;

/** Only the Docker client runs on the host. Generated commands become argv inside a container. */
export const runDockerCommand: DockerRunner = Effect.fn("harnessLearning.runDockerCommand")(
	function* (request: DockerCommand) {
		const env: Record<string, string> = {};
		for (const key of [
			"PATH",
			"HOME",
			"DOCKER_HOST",
			"DOCKER_CONTEXT",
			"DOCKER_CONFIG",
			"DOCKER_TLS_VERIFY",
			"DOCKER_CERT_PATH",
			"XDG_RUNTIME_DIR",
		]) {
			const value = process.env[key];
			if (value !== undefined) env[key] = value;
		}
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(
			ChildProcess.make("docker", request.args, {
				env,
				extendEnv: false,
				stdin: Stream.make(Buffer.from(request.stdin ?? "", "utf8")),
				killSignal: "SIGTERM",
				forceKillAfter: 100,
			}),
		);
		let bytes = 0;
		const collect = (stream: typeof handle.stdout) =>
			Effect.gen(function* () {
				const chunks: Uint8Array[] = [];
				yield* Stream.runForEach(stream, (chunk) =>
					Effect.gen(function* () {
						bytes += chunk.byteLength;
						if (bytes > request.maxOutputBytes)
							return yield* new LabError({ message: `Docker ${request.args[0]} exceeded its output limit` });
						chunks.push(chunk);
						return undefined;
					}),
				);
				return Buffer.concat(chunks).toString("utf8");
			});
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[collect(handle.stdout), collect(handle.stderr), handle.exitCode],
			{ concurrency: 3 },
		);
		return { stdout, stderr, exitCode: Number(exitCode) };
	},
	(effect, request) =>
		effect.pipe(
			Effect.timeout(request.timeoutMs),
			Effect.scoped,
			Effect.provide(NodeServices.layer),
			Effect.mapError((error) =>
				error instanceof LabError
					? error
					: new LabError({ message: `Docker ${request.args[0]} failed: ${error.message}` }),
			),
		),
);
