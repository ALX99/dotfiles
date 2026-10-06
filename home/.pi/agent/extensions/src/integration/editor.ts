import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

export type EditorInputHandler = (editor: CustomEditor, data: string, original: (data: string) => void) => void;

export type EditorRenderDecorator = (lines: string[], width: number) => string[];

export interface EditorComposition {
	setInputHandler(handler: EditorInputHandler): void;
	install(
		context: ExtensionContext,
		options: {
			readonly beforeRender?: (editor: CustomEditor) => void;
			readonly render: EditorRenderDecorator;
			readonly onCreate?: (tui: TUI) => void;
		},
	): void;
}

/**
 * Owns Pi's single editor slot and composes input and rendering behavior in one
 * session-owned CustomEditor subclass. Features provide decorators, never patches.
 */
export function createEditorComposition(): EditorComposition {
	let inputHandler: EditorInputHandler | undefined;

	return {
		setInputHandler(handler) {
			inputHandler = handler;
		},
		install(context, options) {
			context.ui.setEditorComponent((tui, theme, keybindings) => {
				options.onCreate?.(tui);

				class PersonalEditor extends CustomEditor {
					override handleInput(data: string): void {
						const original = super.handleInput.bind(this);
						if (inputHandler) inputHandler(this, data, original);
						else original(data);
					}

					override render(width: number): string[] {
						options.beforeRender?.(this);
						return options.render(super.render(width), width);
					}
				}

				return new PersonalEditor(tui, theme, keybindings);
			});
		},
	};
}
