import * as vscode from 'vscode';

const DISMISSED_KEY = 'emberline.setupPromptDismissed';
// The extension README resolves to the Marketplace landing page and carries a
// real "#setup" anchor; the root README does not, so linking there would just
// dump the reader at the top of the page.
const SETUP_URL = 'https://github.com/l0kifs/emberline/blob/main/extension/README.md#setup';

/**
 * The manual-setup pointer, shown only when the user runs their own server
 * (`emberline.manageServer: false`) and it is unreachable. In the default
 * managed mode the provider never gets here -- ServerManager installs and starts
 * the server instead, so there is no gap to paper over.
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
