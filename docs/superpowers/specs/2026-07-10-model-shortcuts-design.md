# Model Shortcut Keys Design

## Goal

Allow switching directly between the three configured OpenAI Codex models with
`Cmd+1`, `Cmd+2`, and `Cmd+3` while running pi in Ghostty on macOS.

## Model assignments

- `Cmd+1`: `openai-codex/gpt-5.6-sol`
- `Cmd+2`: `openai-codex/gpt-5.6-terra`
- `Cmd+3`: `openai-codex/gpt-5.6-luna`

## Architecture

Add one direct pi extension at
`home/.pi/agent/extensions/model-shortcuts.ts`. The extension registers
`Alt+1`, `Alt+2`, and `Alt+3` shortcuts, resolves the assigned model through
pi's model registry, and calls `pi.setModel()`. It reports missing models,
missing authentication, and successful switches through pi notifications.

Ghostty does not pass macOS Command key presses to terminal applications as
pi key events. Add three Ghostty mappings in `.config/ghostty/config` that
translate `Cmd+1/2/3` into ESC-plus-digit sequences, which pi receives as
`Alt+1/2/3`.

No new dependencies or settings file are required. The assigned models are
already configured in the active provider and settings.

## Error handling

If a model cannot be found, the extension shows a warning and leaves the
current model unchanged. If `pi.setModel()` reports unavailable credentials,
it shows a warning. Successful changes show an informational notification.

## Testing

Add focused TypeScript tests for the exported shortcut/model mapping. Run the
extension check suite with `make check`, and manually verify the Ghostty
mapping lines and pi keybinding behavior.

## Scope

Do not modify unrelated existing working-tree changes. Do not change the
existing enabled-model cycle or add a general-purpose preset system.
