import * as vscode from 'vscode';

import { AbortedError, EmberlineClient, ServerUnreachableError } from './client/http';
import { extractContext, shouldSuppressMidLine } from './completion/context';
import { Debouncer } from './completion/debounce';
import { Config } from './config';
import { Onboarding } from './onboarding';
import { StatusBar } from './status';

export const ACCEPTED_COMMAND = 'emberline.accepted';

/**
 * Thin adapter over the server.
 *
 * Everything latency-sensitive apart from the debounce lives server-side: prompt
 * assembly, caching, and cancellation of superseded work. This provider only
 * decides whether to ask, waits, forwards cursor context, and renders.
 */
export class EmberlineProvider implements vscode.InlineCompletionItemProvider {
	private readonly debouncer = new Debouncer();

	constructor(
		private readonly client: EmberlineClient,
		private readonly cfg: Config,
		private readonly log: vscode.LogOutputChannel,
		private readonly status: StatusBar,
		private readonly onboarding: Onboarding,
	) {}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		if (!this.cfg.isEnabledFor(document)) {
			return undefined;
		}

		const automatic =
			context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;

		// Not asking beats asking faster: a completion offered mid-line, with real
		// code still to the right, is nearly always unusable.
		if (
			automatic &&
			shouldSuppressMidLine(
				document.lineAt(position.line).text,
				position.character,
				this.cfg.maxLineSuffixChars,
			)
		) {
			return undefined;
		}

		const ac = new AbortController();
		const sub = token.onCancellationRequested(() => ac.abort());

		try {
			if (automatic && (await this.debouncer.shouldSkip(this.cfg.debounceMs, ac.signal))) {
				return undefined;
			}
			if (token.isCancellationRequested) {
				return undefined;
			}

			const offset = document.offsetAt(position);
			const { prefix, suffix } = extractContext(
				document.getText(),
				offset,
				this.cfg.maxPrefixChars,
				this.cfg.maxSuffixChars,
			);

			this.status.set('loading');
			const started = Date.now();
			const result = await this.client.complete(
				{
					sessionId: document.uri.toString(),
					prefix,
					suffix,
					languageId: document.languageId,
					// Untitled buffers have no real path; sending the synthetic one would
					// just make the server stat a file that does not exist.
					path: document.uri.scheme === 'file' ? document.uri.fsPath : '',
					openPaths: this.openPaths(document),
				},
				ac.signal,
			);
			const elapsed = Date.now() - started;

			if (token.isCancellationRequested || result.superseded || !result.completion) {
				this.status.set('idle');
				return undefined;
			}

			this.status.set('idle', `last: ${elapsed}ms${result.cached ? ' (cached)' : ''}`);
			if (this.log.logLevel <= vscode.LogLevel.Debug) {
				this.log.debug(
					`completion in ${elapsed}ms cached=${result.cached} ` +
						`len=${result.completion.length} timings=${JSON.stringify(result.timings)}`,
				);
			}

			const item = new vscode.InlineCompletionItem(
				result.completion,
				new vscode.Range(position, position),
			);
			// The stable accept signal. handleEndOfLifetime would be richer but is
			// proposed API, which the Marketplace rejects and which fails silently.
			item.command = {
				command: ACCEPTED_COMMAND,
				title: 'Emberline: completion accepted',
				arguments: [prefix, result.completion, document.languageId],
			};
			return [item];
		} catch (err) {
			if (err instanceof AbortedError) {
				// Routine while typing. Not an error.
				return undefined;
			}
			if (err instanceof ServerUnreachableError) {
				// Expected until the user starts a server, so it gets a pointer to the
				// setup docs rather than a raw fetch message.
				this.status.set('error', 'server unreachable — no completions');
				this.onboarding.serverUnreachable(err.endpoint);
				return undefined;
			}
			const message = err instanceof Error ? err.message : String(err);
			this.log.error(`completion failed: ${message}`);
			this.status.set('error', message);
			return undefined;
		} finally {
			// onCancellationRequested returns a Disposable; leaking it is a real leak.
			sub.dispose();
		}
	}

	/** Paths only -- the server reads and chunks the contents itself. */
	private openPaths(current: vscode.TextDocument): string[] {
		if (!this.cfg.sendOpenFiles) {
			return [];
		}
		const paths: string[] = [];
		for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
			const input = tab.input;
			if (input instanceof vscode.TabInputText && input.uri.scheme === 'file') {
				const p = input.uri.fsPath;
				if (p !== current.uri.fsPath && !paths.includes(p)) {
					paths.push(p);
				}
			}
		}
		return paths.slice(0, 16);
	}
}
