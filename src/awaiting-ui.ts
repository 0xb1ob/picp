/**
 * The outer extension-prompt span pi already coalesces (`ui_prompt_start` /
 * `ui_prompt_end`), as an object so "is a prompt on screen" is a tested value
 * rather than a closure flag. The Awaiting-you overlay that used to read it is
 * retired; session hooks still drive it through `applyPromptWorking`.
 *
 * Imports nothing: no pi, no fs (the composition-root rule, `src/command-post.ts`).
 */
export class HumanPrompt {
	#open = false;

	get open(): boolean {
		return this.#open;
	}

	start(): void {
		this.#open = true;
	}

	end(): void {
		this.#open = false;
	}
}

/**
 * Hide pi's working loader for the outer `ui_prompt` span and restore it when
 * that span ends. Synchronous: pi does not await `ui_prompt_*` handlers.
 */
export function applyPromptWorking(
	ui: { setWorkingVisible(visible: boolean): void },
	prompt: HumanPrompt,
	phase: "start" | "end",
): void {
	if (phase === "start") {
		prompt.start();
		ui.setWorkingVisible(false);
	} else {
		prompt.end();
		ui.setWorkingVisible(true);
	}
}
