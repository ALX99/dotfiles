#!/usr/bin/env python3
"""Query TypeScript's LSP server with a small, script-friendly CLI."""

import argparse
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
from typing import Any
from urllib.parse import unquote, urlparse


POSITION_COMMANDS = {"definition", "references", "implementations", "type-definition", "hover"}
LANGUAGE_IDS = {".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".mts": "typescript", ".cts": "typescript"}
IGNORED_DIRECTORIES = {".git", "node_modules"}
SYMBOL_KINDS = (
    "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
    "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array",
    "object", "key", "null", "enum-member", "struct", "event", "operator", "type-parameter",
)


class LspError(RuntimeError):
    pass


class Client:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.process = subprocess.Popen(
            ["tsc", "--lsp", "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert self.process.stdin and self.process.stdout and self.process.stderr
        self._stdin = self.process.stdin
        self._stdout = self.process.stdout
        self._messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self._write_lock = threading.Lock()
        self._next_id = 1
        self._reader = threading.Thread(target=self._read_messages, daemon=True)
        self._reader.start()
        self._stderr: list[str] = []
        self._stderr_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self._stderr_reader.start()

    def _read_stderr(self) -> None:
        assert self.process.stderr
        for line in iter(self.process.stderr.readline, b""):
            self._stderr.append(line.decode("utf-8", "replace").rstrip())
        del self._stderr[:-20]

    def _read_messages(self) -> None:
        try:
            while True:
                headers: dict[bytes, bytes] = {}
                while True:
                    line = self._stdout.readline()
                    if not line:
                        return
                    if line in (b"\r\n", b"\n"):
                        break
                    key, separator, value = line.partition(b":")
                    if not separator:
                        raise LspError("malformed LSP header from tsc")
                    headers[key.lower()] = value.strip()
                length = int(headers[b"content-length"])
                body = self._stdout.read(length)
                if len(body) != length:
                    raise LspError("truncated LSP message from tsc")
                self._messages.put(json.loads(body.decode("utf-8")))
        except Exception as error:
            self._messages.put({"__reader_error__": str(error)})

    def _send(self, message: dict[str, Any]) -> None:
        data = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        with self._write_lock:
            self._stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode() + data)
            self._stdin.flush()

    def _handle_server_message(self, message: dict[str, Any]) -> None:
        if "method" not in message or "id" not in message:
            return
        method = message["method"]
        params = message.get("params", {})
        if method == "workspace/configuration":
            result = [None for _ in params.get("items", [])]
            self._send({"jsonrpc": "2.0", "id": message["id"], "result": result})
        elif method == "client/registerCapability":
            self._send({"jsonrpc": "2.0", "id": message["id"], "result": None})
        elif method == "window/showMessageRequest":
            self._send({"jsonrpc": "2.0", "id": message["id"], "result": None})
        else:
            self._send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": f"Unsupported server request: {method}"}})

    def request(self, method: str, params: dict[str, Any]) -> Any:
        request_id = self._next_id
        self._next_id += 1
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        while True:
            try:
                message = self._messages.get(timeout=30)
            except queue.Empty:
                raise LspError(f"timed out waiting for {method}") from None
            if "__reader_error__" in message:
                raise LspError(message["__reader_error__"])
            if message.get("id") == request_id and "method" not in message:
                if "error" in message:
                    raise LspError(message["error"].get("message", str(message["error"])))
                return message.get("result")
            self._handle_server_message(message)

    def notify(self, method: str, params: dict[str, Any]) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                self.request("shutdown", {})
                self.notify("exit", {})
                self.process.wait(timeout=3)
            except (LspError, OSError, subprocess.TimeoutExpired):
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()


def discover_root(file: Path | None, explicit_root: str | None) -> Path:
    if explicit_root:
        root = Path(explicit_root).expanduser().resolve()
        if not root.is_dir():
            raise LspError(f"root is not a directory: {root}")
        return root
    start = file.parent if file else Path.cwd()
    for directory in (start, *start.parents):
        if (directory / "tsconfig.json").is_file() or (directory / "jsconfig.json").is_file():
            return directory
    return start


def position(file: Path, line: int, column: int) -> dict[str, int]:
    if line < 1 or column < 1:
        raise LspError("line and column must be 1 or greater")
    try:
        source_line = file.read_text(encoding="utf-8").splitlines()[line - 1]
    except IndexError:
        raise LspError(f"line {line} is outside {file}") from None
    if column > len(source_line) + 1:
        raise LspError(f"column {column} is outside line {line} of {file}")
    return {"line": line - 1, "character": len(source_line[: column - 1].encode("utf-16-le")) // 2}


def parse_location(value: str) -> tuple[Path, int, int]:
    """Parse FILE:LINE:COLUMN, allowing colons in FILE."""
    try:
        file_name, line_text, column_text = value.rsplit(":", 2)
        line = int(line_text)
        column = int(column_text)
    except ValueError:
        raise LspError("location must be FILE:LINE:COLUMN") from None
    if not file_name:
        raise LspError("location must include a file")
    return Path(file_name).expanduser().resolve(), line, column


def workspace_seed(root: Path) -> Path | None:
    """Return one source file to make TypeScript load the configured project."""
    for directory, directories, names in os.walk(root):
        directories[:] = sorted(name for name in directories if name not in IGNORED_DIRECTORIES)
        for name in sorted(names):
            candidate = Path(directory, name)
            if candidate.suffix in LANGUAGE_IDS:
                return candidate
    return None


def display_location(location: dict[str, Any]) -> str:
    uri = location["uri"]
    parsed = urlparse(uri)
    path = unquote(parsed.path) if parsed.scheme == "file" else uri
    source_range = location["range"]
    start = source_range["start"]
    end = source_range["end"]
    start_line = start["line"] + 1
    end_line = end["line"] + 1
    start_column = start["character"] + 1
    end_column = end["character"] + 1
    if start_line == end_line:
        range_text = f"{start_line}:{start_column}-{end_column}"
    else:
        range_text = f"{start_line}:{start_column}-{end_line}:{end_column}"
    return f"{path}:{range_text}"


def display_symbol(symbol: dict[str, Any], indent: str = "") -> list[str]:
    kind = SYMBOL_KINDS[symbol["kind"] - 1].replace("-", " ").title()
    location = display_location(symbol["location"])
    lines = [f"{indent}{location} {symbol['name']} {kind}"]
    for child in symbol.get("children", []):
        lines.extend(display_symbol(child, f"{indent}\t"))
    return lines


def display_result(command: str, result: Any) -> list[str]:
    if command == "hover":
        if result is None:
            return []
        contents = result["contents"]
        if isinstance(contents, str):
            return [contents]
        if isinstance(contents, dict):
            return [contents["value"]]
        return [item if isinstance(item, str) else item["value"] for item in contents]
    if command in {"document-symbols", "workspace-symbols"}:
        return [line for symbol in result or [] for line in display_symbol(symbol)]
    locations = result or []
    if isinstance(locations, dict):
        locations = [locations]
    return [display_location(location) for location in locations]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", help="project root (default: nearest tsconfig.json/jsconfig.json)")
    parser.add_argument("command", choices=[*sorted(POSITION_COMMANDS), "document-symbols", "workspace-symbols"])
    parser.add_argument("target", nargs="?", help="source file, or FILE:LINE:COLUMN for position commands")
    parser.add_argument("--query", default="", help="workspace-symbols search query")
    args = parser.parse_args()

    needs_position = args.command in POSITION_COMMANDS
    if args.command == "workspace-symbols":
        if args.target:
            parser.error("workspace-symbols takes no source file")
    elif not args.target:
        parser.error(f"{args.command} requires FILE")

    if needs_position:
        file, line, column = parse_location(args.target)
    else:
        file = Path(args.target).expanduser().resolve() if args.target else None
        line = column = None
    if file and not file.is_file():
        raise LspError(f"file does not exist: {file}")
    root = discover_root(file, args.root)
    client = Client(root)
    try:
        root_uri = root.as_uri()
        client.request("initialize", {
            "processId": os.getpid(), "rootUri": root_uri,
            "workspaceFolders": [{"uri": root_uri, "name": root.name}],
            "capabilities": {"workspace": {"configuration": True, "workspaceFolders": True, "didChangeConfiguration": {"dynamicRegistration": True}}},
        })
        client.notify("initialized", {})
        uri = file.as_uri() if file else None
        if file and (needs_position or args.command == "document-symbols"):
            client.notify("textDocument/didOpen", {"textDocument": {"uri": uri, "languageId": LANGUAGE_IDS.get(file.suffix, "typescript"), "version": 1, "text": file.read_text(encoding="utf-8")}})
        methods = {
            "definition": "textDocument/definition", "references": "textDocument/references",
            "implementations": "textDocument/implementation", "type-definition": "textDocument/typeDefinition",
            "hover": "textDocument/hover", "document-symbols": "textDocument/documentSymbol",
            "workspace-symbols": "workspace/symbol",
        }
        if args.command == "workspace-symbols":
            seed = workspace_seed(root)
            if seed:
                client.notify("textDocument/didOpen", {"textDocument": {"uri": seed.as_uri(), "languageId": LANGUAGE_IDS[seed.suffix], "version": 1, "text": seed.read_text(encoding="utf-8")}})
            result = client.request(methods[args.command], {"query": args.query})
        elif args.command == "document-symbols":
            result = client.request(methods[args.command], {"textDocument": {"uri": uri}})
        else:
            assert file and line is not None and column is not None
            params: dict[str, Any] = {"textDocument": {"uri": uri}, "position": position(file, line, column)}
            if args.command == "references":
                params["context"] = {"includeDeclaration": True}
            result = client.request(methods[args.command], params)
        for line in display_result(args.command, result):
            print(line)
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (LspError, OSError, UnicodeError) as error:
        print(f"tsc_lsp.py: {error}", file=sys.stderr)
        raise SystemExit(1)
