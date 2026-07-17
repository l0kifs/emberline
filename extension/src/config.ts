import * as vscode from 'vscode';

/**
 * Where to write a toggled value: the narrowest scope that already defines it,
 * because that is the one currently winning. Falls back to user settings, which
 * is also the only scope that exists with no folder open.
 */
function writeScope(info: ReturnType<vscode.WorkspaceConfiguration['inspect']>): {
	target: vscode.ConfigurationTarget;
	inLanguage: boolean;
} {
	const { Global, Workspace, WorkspaceFolder } = vscode.ConfigurationTarget;
	if (info?.workspaceFolderLanguageValue !== undefined) {
		return { target: WorkspaceFolder, inLanguage: true };
	}
	if (info?.workspaceFolderValue !== undefined) {
		return { target: WorkspaceFolder, inLanguage: false };
	}
	if (info?.workspaceLanguageValue !== undefined) {
		return { target: Workspace, inLanguage: true };
	}
	if (info?.workspaceValue !== undefined) {
		return { target: Workspace, inLanguage: false };
	}
	if (info?.globalLanguageValue !== undefined) {
		return { target: Global, inLanguage: true };
	}
	return { target: Global, inLanguage: false };
}

/**
 * Snapshot of settings, refreshed on change.
 *
 * Reading `getConfiguration()` on every keystroke is measurable; reading it once
 * per change is not. Resource-scoped lookups pass the document, otherwise
 * per-language and per-folder overrides are silently ignored.
 */
export class Config implements vscode.Disposable {
	private readonly disposable: vscode.Disposable;
	private readonly onChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onChange.event;

	endpoint = 'http://127.0.0.1:8011';
	debounceMs = 150;
	timeoutMs = 5000;
	disabledLanguages: string[] = [];
	maxPrefixChars = 8192;
	maxSuffixChars = 2048;
	maxLineSuffixChars = 8;
	sendOpenFiles = true;

	constructor(private readonly log: vscode.LogOutputChannel) {
		this.reload();
		this.disposable = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('emberline')) {
				this.reload();
				this.onChange.fire();
			}
		});
	}

	private reload(): void {
		const c = vscode.workspace.getConfiguration('emberline');
		this.endpoint = c.get('endpoint', 'http://127.0.0.1:8011');
		this.debounceMs = c.get('debounceMs', 150);
		this.timeoutMs = c.get('timeoutMs', 5000);
		this.disabledLanguages = c.get('disabledLanguages', []);
		this.maxPrefixChars = c.get('maxPrefixChars', 8192);
		this.maxSuffixChars = c.get('maxSuffixChars', 2048);
		this.maxLineSuffixChars = c.get('maxLineSuffixChars', 8);
		this.sendOpenFiles = c.get('sendOpenFiles', true);
		this.log.info(
			`config: endpoint=${this.endpoint} debounce=${this.debounceMs}ms timeout=${this.timeoutMs}ms`,
		);
	}

	/** `emberline.enabled` is language-overridable, so it needs the document. */
	isEnabledFor(document: vscode.TextDocument): boolean {
		if (this.disabledLanguages.includes(document.languageId)) {
			return false;
		}
		return this.enabledSetting(document);
	}

	/** `emberline.enabled` alone, ignoring the language blocklist. */
	private enabledSetting(document?: vscode.TextDocument): boolean {
		return vscode.workspace.getConfiguration('emberline', document).get('enabled', true);
	}

	/**
	 * Flip `emberline.enabled` and return the new value.
	 *
	 * Writes the setting rather than a module-local flag: a flag does not survive
	 * a reload, and gives two gates that can disagree in the status bar. There is
	 * exactly one source of truth.
	 *
	 * The write goes to whichever scope already defines the value. Toggling a
	 * workspace-disabled Emberline into user settings would leave the workspace
	 * value still winning, so the command would look broken.
	 */
	async toggle(document?: vscode.TextDocument): Promise<boolean> {
		const c = vscode.workspace.getConfiguration('emberline', document);
		const next = !this.enabledSetting(document);
		const { target, inLanguage } = writeScope(c.inspect<boolean>('enabled'));
		await c.update('enabled', next, target, inLanguage);
		return next;
	}

	dispose(): void {
		this.disposable.dispose();
		this.onChange.dispose();
	}
}
