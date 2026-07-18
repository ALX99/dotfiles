# Codex `apply_patch` tool

This extension supplies the filesystem implementation of `apply_patch` and
activates it only for Pi models whose provider is `openai-codex`. While active,
it disables Pi's normal `edit` and `write` tools.

The raw OpenAI Responses custom-tool codec is supplied by the version-pinned
native Pi patch in [`misc/pi-patches/`](../../../../../misc/pi-patches/). Apply
and verify that patch after installing or upgrading Pi:

```sh
node misc/pi-patches/apply-pi-ai-0.80.10.mjs
node misc/pi-patches/apply-pi-ai-0.80.10.mjs --check
```

There is no separate direct OpenAI API provider and no `OPENAI_API_KEY`
dependency. Pi's existing ChatGPT OAuth Codex provider performs the request.
The native patch opts only that provider into raw `apply_patch` conversion;
other callers of the shared Responses codec continue to send ordinary function
tools. Codex requests set `parallel_tool_calls: false` until raw custom calls
and their filesystem mutations are safe to correlate in parallel.

`apply_patch` accepts add, update, delete, move, chunks, and EOF markers. It
uses slash-separated patch paths on every platform and rejects backslashes,
absolute/traversing/symlink paths, canonical or hard-link aliases for existing
targets, and ancestor/descendant conflicts. It caps UTF-8 input at 512 KiB and
applies without an extension-level confirmation prompt.

Preflight hashes every source, mutation locks use canonical paths, and apply
revalidates paths immediately before each commit step. Replacements are staged
first; the engine creates and verifies a same-directory backup hardlink while
the original path still exists, then atomically renames the staged replacement
over that path. Normal updates and their rollback therefore never expose an
`ENOENT` window. Moves publish the destination before removing the source.
If a later file fails, the engine restores earlier files in reverse order. A
failure reports the applied set, restored set, rollback errors, and any journal
paths retained for manual recovery.

These checks reduce ordinary races; they are not a hostile-filesystem
guarantee. Pi's mutation queue is process-local, and portable Node APIs do not
provide an `openat`/directory-handle transaction or compare-and-swap rename.
Another process can still change a path component or an open inode between the
last check and a filesystem call. In particular, a parent-directory swap in
that final gap can redirect a pathname-based operation. Full prevention needs
a native descriptor-relative helper built on facilities such as
`openat`/`renameat`; portable Node filesystem APIs cannot provide that
containment guarantee. The engine rechecks stable parent directory identities
before and after commit calls, but this only narrows the race. Rollback refuses
to overwrite or remove a file whose content changed and retains the original
journal file when automatic recovery is unsafe. Process termination or machine
failure during the short commit window can also leave `.apply-patch-*`
recovery files. Two distinct spellings of a still-missing path may remain
indistinguishable on a case-folding or Unicode-normalizing filesystem;
exclusive creation makes the second spelling fail rather than overwrite, and
the transaction then rolls back.
