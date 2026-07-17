/**
 * Transport to the Emberline server.
 *
 * Uses the global `fetch`. The extension host (Electron/Node 24) patches
 * `globalThis.fetch` with proxy resolution and OS certificate handling, so
 * bundling axios or node-fetch would actively lose corporate proxy support
 * rather than add anything.
 *
 * No `vscode` import: this file is unit-testable without an extension host.
 */

export interface CompleteParams {
	sessionId: string;
	prefix: string;
	suffix: string;
	languageId: string;
	path: string;
	openPaths: string[];
}

export interface CompleteResult {
	completion: string;
	cached: boolean;
	superseded: boolean;
	stopType: string | null;
	timings: Record<string, number>;
}

export class AbortedError extends Error {
	constructor() {
		super('aborted');
		this.name = 'AbortedError';
	}
}

/**
 * Nothing is listening on the endpoint. Distinct from a generic failure because
 * it is the one error with an actionable cause: Emberline ships no server, so
 * for a new user this is the expected first-run state, not a fault.
 */
export class ServerUnreachableError extends Error {
	constructor(readonly endpoint: string) {
		super(`cannot reach Emberline server at ${endpoint}`);
		this.name = 'ServerUnreachableError';
	}
}

export class EmberlineClient {
	constructor(
		private readonly endpoint: () => string,
		private readonly timeoutMs: () => number,
	) {}

	async complete(params: CompleteParams, signal: AbortSignal): Promise<CompleteResult> {
		const body = {
			session_id: params.sessionId,
			prefix: params.prefix,
			suffix: params.suffix,
			language_id: params.languageId,
			path: params.path,
			open_paths: params.openPaths,
		};
		const json = await this.post('/v1/complete', body, signal);
		return {
			completion: typeof json.completion === 'string' ? json.completion : '',
			cached: Boolean(json.cached),
			superseded: Boolean(json.superseded),
			stopType: json.stop_type ?? null,
			timings: json.timings ?? {},
		};
	}

	/** Fire-and-forget: an accepted completion becomes a retrieval example. */
	async accept(prefix: string, completion: string, languageId: string): Promise<void> {
		const ac = new AbortController();
		await this.post(
			'/v1/accept',
			{ prefix, completion, language_id: languageId },
			ac.signal,
		);
	}

	private async post(
		path: string,
		body: unknown,
		signal: AbortSignal,
	): Promise<Record<string, any>> {
		// Caller cancellation and a hard timeout, combined. Both are Node built-ins.
		const combined = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs())]);
		let res: Response;
		try {
			res = await fetch(`${this.endpoint().replace(/\/+$/, '')}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: combined,
			});
		} catch (err) {
			// AbortError and TimeoutError both mean "nobody is waiting for this any
			// more" -- normal during typing, and never worth surfacing as an error.
			const name = (err as Error)?.name;
			if (name === 'AbortError' || name === 'TimeoutError') {
				throw new AbortedError();
			}
			// fetch rejects with TypeError for every transport-level failure
			// (connection refused, DNS, TLS). By this point it is not an abort, so
			// the endpoint is not answering.
			if (err instanceof TypeError) {
				throw new ServerUnreachableError(this.endpoint());
			}
			throw err;
		}
		if (!res.ok) {
			throw new Error(`${path} -> ${res.status} ${res.statusText}`);
		}
		return (await res.json()) as Record<string, any>;
	}
}
