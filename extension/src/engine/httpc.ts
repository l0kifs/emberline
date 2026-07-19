/**
 * Minimal HTTP client for the engine's own outbound calls.
 *
 * `node:http`, not the global `fetch`. The "global fetch, no HTTP library" rule
 * is an *extension* invariant: it exists so the host's proxy resolution and OS
 * certificate store apply to requests that leave the machine. Neither concerns a
 * 127.0.0.1 hop between two processes we spawned, and `node:http` buys explicit
 * keep-alive control that undici's defaults do not expose -- see infill.ts, where
 * dropping the warm connection between keystrokes would be a measurable cost.
 *
 * Do not "modernise" this to fetch.
 */

import * as http from 'node:http';

/**
 * Status code of a GET, or undefined if the request did not complete.
 *
 * Used for liveness probes, where every failure mode means the same thing
 * ("not up yet") and none of them are worth distinguishing.
 */
export function getStatus(url: string, timeoutMs: number): Promise<number | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (code: number | undefined) => {
			if (!settled) {
				settled = true;
				resolve(code);
			}
		};
		const req = http.get(url, { agent: false }, (res) => {
			// Drain: an unread response holds the socket open.
			res.resume();
			done(res.statusCode);
		});
		req.setTimeout(timeoutMs, () => req.destroy());
		req.on('error', () => done(undefined));
		req.on('close', () => done(undefined));
	});
}

export function readAll(stream: NodeJS.ReadableStream): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (c: Buffer) => chunks.push(c));
		stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		stream.on('error', reject);
	});
}
