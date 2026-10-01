import { runPromise } from "../../_shared/effect-runtime.ts";
import { toError } from "../../_shared/errors.ts";
import { runLabCli } from "./cli.ts";

const controller = new AbortController();
let signalExitCode = 0;
const interrupt = () => {
	signalExitCode = 130;
	controller.abort();
};
const terminate = () => {
	signalExitCode = 143;
	controller.abort();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
try {
	await runPromise(runLabCli(process.argv.slice(2)), { signal: controller.signal });
} catch (error) {
	process.exitCode = signalExitCode || 1;
	console.error(toError(error).message);
} finally {
	process.removeListener("SIGINT", interrupt);
	process.removeListener("SIGTERM", terminate);
}
