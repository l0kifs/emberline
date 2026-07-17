import * as vscode from 'vscode';

import { EmberlineClient } from './client/http';
import { Config } from './config';
import { createLogger } from './logging';
import { Onboarding } from './onboarding';
import { ACCEPTED_COMMAND, EmberlineProvider } from './provider';
import { StatusBar } from './status';

/**
 * Wiring only. Nothing expensive happens at module load or during activate --
 * the extension activates on `onStartupFinished` and must not cost anything
 * until the user actually types.
 */
export function activate(context: vscode.ExtensionContext): void {
	const log = createLogger();
	context.subscriptions.push(log);
	log.info('Emberline activating');

	const cfg = new Config(log);
	context.subscriptions.push(cfg);

	const status = new StatusBar();
	context.subscriptions.push(status);

	// `emberline.enabled` is language-overridable and the language blocklist is a
	// second condition, so "is Emberline on" is only answerable about a specific
	// document. The status bar tracks the active one.
	const refreshStatus = (): void => {
		const doc = vscode.window.activeTextEditor?.document;
		status.set(doc && !cfg.isEnabledFor(doc) ? 'disabled' : 'idle');
	};

	const client = new EmberlineClient(
		() => cfg.endpoint,
		() => cfg.timeoutMs,
	);

	// globalState, not workspaceState: "I know Emberline needs a server" is a fact
	// about the user, not about one folder.
	const onboarding = new Onboarding(context.globalState, log);

	const provider = new EmberlineProvider(client, cfg, log, status, onboarding);

	refreshStatus();
	context.subscriptions.push(
		cfg.onDidChange(refreshStatus),
		vscode.window.onDidChangeActiveTextEditor(refreshStatus),
	);

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(
			// Enumerated rather than `{ pattern: '**' }`: that would also fire in diff
			// views, git previews, output panes and the SCM input box. 'untitled' is
			// required -- a brand new unsaved buffer is exactly when completion helps.
			[{ scheme: 'file' }, { scheme: 'untitled' }],
			provider,
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('emberline.toggle', async () => {
			const doc = vscode.window.activeTextEditor?.document;
			const on = await cfg.toggle(doc);
			refreshStatus();
			// Turning it on cannot beat the language blocklist, and silently doing
			// nothing is worse than saying why.
			const blocked = doc !== undefined && cfg.disabledLanguages.includes(doc.languageId);
			const caveat =
				on && blocked
					? ` (still off for ${doc.languageId} — see emberline.disabledLanguages)`
					: '';
			void vscode.window.showInformationMessage(
				`Emberline inline completions ${on ? 'enabled' : 'disabled'}${caveat}`,
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('emberline.showLogs', () => log.show()),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			ACCEPTED_COMMAND,
			async (prefix: string, completion: string, languageId: string) => {
				try {
					await client.accept(prefix, completion, languageId);
					log.debug(`recorded accepted completion (${completion.length} chars)`);
				} catch (err) {
					// Recording an example is best-effort; never bother the user about it.
					log.debug(`accept reporting failed: ${(err as Error)?.message}`);
				}
			},
		),
	);

	log.info('Emberline ready');
}

export function deactivate(): void {
	// Everything lives in context.subscriptions.
}
