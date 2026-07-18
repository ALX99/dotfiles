/** Compatibility facade for callers that predate the protocol split. */
export type { RpcEvent } from "./protocol.ts";
export {
	DEFAULT_RPC_CLOSE_GRACE_MS,
	DEFAULT_RPC_MAX_FRAME_BYTES,
	DEFAULT_RPC_MAX_QUEUED_WRITE_BYTES,
	DEFAULT_RPC_MAX_STDERR_BYTES,
	DEFAULT_RPC_MAX_STDERR_LINES,
	DEFAULT_RPC_REQUEST_TIMEOUT_MS,
	RpcTransport,
	type RpcRequestOptions,
	type RpcTransportOptions,
	type RpcTransportState,
	type SpawnRpcProcess,
} from "./rpc-transport.ts";
