import * as vscode from 'vscode';

/**
 * `LogOutputChannel` rather than a hand-rolled `OutputChannel`: it gives
 * timestamps, level filtering, and a user-facing level picker for free.
 */
export function createLogger(): vscode.LogOutputChannel {
	return vscode.window.createOutputChannel('Emberline', { log: true });
}
