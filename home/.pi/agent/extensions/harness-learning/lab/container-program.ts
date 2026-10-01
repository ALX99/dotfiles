import { MAX_TASK_FILE_CHARS, MAX_TASK_FILES_BYTES } from "./schema.ts";

/** Container-only I/O. The controller Schema-validates paths; this program checks the live filesystem for links. */
export const CONTAINER_FILE_PROGRAM = String.raw`
const MAX_BYTES = ${MAX_TASK_FILES_BYTES};
const MAX_CHARS = ${MAX_TASK_FILE_CHARS};
const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
function checked(base, relative, mkdir = false) {
  const parts = relative.split("/");
  let parent = base;
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (mkdir && !fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o755 });
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Linked or non-directory parent");
  }
  return path.join(base, relative);
}
function read(base, relative) {
  const file = checked(base, relative);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("Not a bounded, unlinked regular file");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_BYTES) throw new Error("File exceeded its byte limit");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    if (content.length > MAX_CHARS) throw new Error("File exceeded its text limit");
    return content;
  } finally { fs.closeSync(fd); }
}
function write(base, file, readonly = false) {
  const target = checked(base, file.path, true);
  const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Linked or non-regular write target");
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, file.content, "utf8");
    if (readonly) fs.fchmodSync(fd, 0o444);
  } finally { fs.closeSync(fd); }
}
if (input.operation === "seed") {
  for (const file of input.files) write("/workspace", file, input.readonly);
  for (const file of input.verify ?? []) write("/verify", file, true);
  process.stdout.write("ok");
} else if (input.operation === "read") {
  process.stdout.write(read("/workspace", input.path));
} else if (input.operation === "write") {
  write("/workspace", input);
  process.stdout.write("ok");
} else if (input.operation === "export") {
  const files = [];
  let bytes = 0;
  for (const relative of input.paths) {
    let content;
    try { content = read("/workspace", relative); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    bytes += Buffer.byteLength(content, "utf8");
    if (bytes > MAX_BYTES) throw new Error("Artifacts exceeded their byte total");
    files.push({ path: relative, content });
  }
  process.stdout.write(JSON.stringify(files));
} else throw new Error("Unknown file operation");
`;
