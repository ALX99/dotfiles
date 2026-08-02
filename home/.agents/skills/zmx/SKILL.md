---
name: zmx
summary: Drive and debug persistent terminal UIs through local zmx sessions.
description: Use when a task requires programmatic keyboard control, inspection, or recovery of an interactive terminal UI (TUI), editor, pager, prompt, or REPL across tool calls.
---

# Drive and debug TUIs with zmx

`zmx` provides a persistent PTY. `send` writes raw input bytes; `history`
returns the rendered terminal and scrollback. It does not expose widgets,
cursor targets, or native GUI controls.

## Start safely

Check the installed interface, then choose a unique session. Never reuse or
kill a session you did not create.

```sh
zmx version
zmx help
zmx list
s="agent-<task>-<unique>"
zmx run "$s" true
```

Launch interactive programs by typing into the persistent shell. **Do not**
launch a TUI with `run`: `run` waits for a completion marker that an
interactive program will not produce.

```sh
printf '%s\r' 'cd /path/to/project && lazygit' | zmx send "$s"
sleep 0.5
zmx history "$s" | tail -80
```

Use `run`, followed by `wait`, only for noninteractive commands:

```sh
zmx run "$s" npm test
zmx wait "$s"
```

## Use an observe–act–verify loop

Before and after each meaningful key:

1. Take a fresh `history` snapshot.
2. Identify the visible focus, mode, prompt, or dialog.
3. Send one logical action.
4. Wait briefly, then verify the expected screen change.

Do not infer success from a delay or from `send` returning successfully;
`send` is fire-and-forget. Poll for a concrete screen change during long
operations. Open the application's visible help before guessing shortcuts.

```sh
zmx history "$s" > /tmp/"$s".txt
printf 'j' | zmx send "$s"
sleep 0.2
zmx history "$s" | tail -80
```

Plain history is compact and usually sufficient. Use HTML when color,
highlighting, or layout identifies focus:

```sh
zmx history "$s" --html > /tmp/"$s".html
```

Use `--vt` only to diagnose terminal negotiation, modes, and rendering. It
contains escape sequences rather than a convenient screen snapshot:

```sh
zmx history "$s" --vt > /tmp/"$s".vt
```

## Send exact bytes

`send` adds no Enter. Prefer `printf` via stdin so the intended bytes are
explicit.

| Key | Bytes |
| --- | --- |
| Enter | `\r` |
| Tab / Shift-Tab | `\t` / `\033[Z` |
| Backspace / Delete | `\177` / `\033[3~` |
| Up / Down / Right / Left | `\033[A` / `\033[B` / `\033[C` / `\033[D` |
| Escape | `\033` |
| Ctrl-C / Ctrl-D / Ctrl-L | `\003` / `\004` / `\014` |
| Alt-x | `\033x` |

Examples:

```sh
printf '%s\r' 'search text' | zmx send "$s"
printf '\003' | zmx send "$s"
```

Prefer an application's letter shortcuts when available. Because zmx sends
bytes without a terminal emulator translating keys, conventional arrows may
fail in application-cursor or enhanced-keyboard mode. Try one sequence and
verify movement before trying another:

```sh
printf '\033OB'   | zmx send "$s" # application-cursor Down
printf '\033[1;1B' | zmx send "$s" # Kitty-protocol Down
```

Modern TUIs may request the Kitty keyboard protocol (visible in `--vt` as a
keyboard-protocol negotiation such as `CSI =1;1u`). A bare Escape is then an
ambiguous prefix and may not close a dialog. Send its unambiguous key event:

```sh
printf '\033[27;1u' | zmx send "$s" # Kitty Escape
```

This was required for Neovim navigation and reliably dismissed lazygit and Pi
states during testing. Always confirm that the mode, dialog, or selection
actually changed.

For multiline or control-character-heavy content, avoid simulated paste.
Transfer a file, then open/import it in the application:

```sh
printf '%s' "$content" | zmx write "$s" input.txt
```

## Capture useful debugging evidence

For a reproducible TUI failure, preserve only:

- `zmx version`, application version, launch command, and working directory;
- terminal geometry (`zmx run "$s" stty size` before launching the TUI);
- a plain or HTML snapshot immediately before and after the failed input;
- the exact input bytes sent and the expected visible change;
- `history --vt` when keyboard negotiation, mouse mode, color, or rendering is
  implicated.

Common diagnoses:

- **No movement:** selection may be color-only; inspect HTML, then test the
  application's letter key, application-cursor sequence, or Kitty sequence.
- **Escape does nothing:** try Kitty Escape and verify the dialog closes.
- **Input appears as text:** focus is in a prompt/filter, not the main view.
- **App appears hung:** inspect history for a prompt or modal; if it was
  mistakenly started with `run`, interrupt it with Ctrl-C.
- **Screen looks corrupt:** compare plain, HTML, and VT histories and record
  geometry; do not blindly send more keys.
- **Startup pauses or reports a DSR timeout:** the application queried a
  terminal capability that the headless session did not answer (Neovim may
  report `E1568`). Preserve the warning and VT history; it is a harness
  limitation, not necessarily an application hang.
- **Quit seems ineffective:** alternate-screen restoration may reveal earlier
  scrollback. Confirm the shell prompt returned rather than relying on the
  last TUI lines.

## Exit and clean up

Use the application's documented quit key and confirm the shell prompt
returned. Ctrl-C is a recovery fallback, not a safe substitute when an
application may need to save or restore terminal state.

```sh
printf 'q' | zmx send "$s"
zmx history "$s" | tail -30
zmx kill "$s" --force
```

Kill only sessions created for the task. Never use `zmx detach` as cleanup; it
detaches clients from every session. Avoid nested zmx sessions over SSH
because terminal restoration is unreliable.
