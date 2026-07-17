import * as vscode from 'vscode';

const DISMISSED_KEY = 'emberline.setupPromptDismissed';
const SETUP_URL = 'https://github.com/l0kifs/emberline#setup';

/**
 * The first-run gap: Emberline ships no server, so an install from the
 * Marketplace produces silent nothing until the user starts one. The status bar
 * alone does not carry that -- a warning icon does not tell you to go run
 * `uv run emberline-server`.
 *
 * Shown at most once per session, and never again after "Don't Show Again".
 * The provider calls this per keystroke, so both gates have to be cheap and the
 * session latch has to be set synchronously.
 */
export class Onboarding {
	private shown = false;

	constructor(
		private readonly state: vscode.Memento,
		private readonly log: vscode.LogOutputChannel,
	) {}

	serverUnreachable(endpoint: string): void {
		if (this.shown || this.state.get(DISMISSED_KEY, false)) {
			return;
		}
		// Latch before the await: provideInlineCompletionItems fires again while
		// this dialog is open, and a per-keystroke stack of them is unusable.
		this.shown = true;
		void this.prompt(endpoint);
	}

	private async prompt(endpoint: string): Promise<void> {
		this.log.warn(`server unreachable at ${endpoint}; prompting for setup`);
		const choice = await vscode.window.showWarningMessage(
			`Emberline can't reach its server at ${endpoint}. Emberline runs completions ` +
				`on a local server that you start yourself — it isn't bundled with the extension.`,
			'Setup Instructions',
			'Show Logs',
			"Don't Show Again",
		);
		switch (choice) {
			case 'Setup Instructions':
				void vscode.env.openExternal(vscode.Uri.parse(SETUP_URL));
				break;
			case 'Show Logs':
				this.log.show();
				break;
			case "Don't Show Again":
				void this.state.update(DISMISSED_KEY, true);
				break;
		}
	}
}
