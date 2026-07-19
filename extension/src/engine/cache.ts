/**
 * Bounded LRU for completion results.
 *
 * Keyed on a hash of the context that actually reaches the model, so arrowing
 * around and returning to a position is free.
 */

import { createHash } from 'node:crypto';

/**
 * Hash the context that determines a completion.
 *
 * Encoded UTF-16LE, not UTF-8. The extension slices the document by offset, so a
 * cursor can land between the halves of a surrogate pair and hand us a string
 * containing a lone surrogate. `Buffer.from(s, 'utf8')` maps every such
 * surrogate to the same U+FFFD, which would let two genuinely different prefixes
 * collide and serve each other's completions. UTF-16LE is injective over JS
 * strings, so the hash distinguishes what the caller distinguishes.
 *
 * The NUL separators are what stop ("ab","c") and ("a","bc") hashing alike.
 */
export function contextKey(
	prefix: string,
	suffix: string,
	extraDigest: string,
	paramsDigest: string,
): string {
	const h = createHash('sha256');
	for (const part of [prefix, '\x00', suffix, '\x00', extraDigest, '\x00', paramsDigest]) {
		h.update(Buffer.from(part, 'utf16le'));
	}
	return h.digest('hex');
}

/** Same encoding rule as `contextKey`, for the extra-context digest. */
export function digest(parts: string[]): string {
	const h = createHash('sha256');
	for (const p of parts) {
		h.update(Buffer.from(p, 'utf16le'));
		h.update(Buffer.from('\x00', 'utf16le'));
	}
	return h.digest('hex').slice(0, 16);
}

export class CompletionCache {
	// A Map iterates in insertion order, so delete+set moves an entry to the back
	// and the first key is always the least recently used.
	private readonly data = new Map<string, string>();
	hits = 0;
	misses = 0;

	constructor(private readonly max: number = 250) {}

	get(key: string): string | undefined {
		const value = this.data.get(key);
		if (value === undefined) {
			this.misses++;
			return undefined;
		}
		this.data.delete(key);
		this.data.set(key, value);
		this.hits++;
		return value;
	}

	put(key: string, value: string): void {
		if (this.data.has(key)) {
			this.data.delete(key);
		} else if (this.data.size >= this.max) {
			const oldest = this.data.keys().next();
			if (!oldest.done) {
				this.data.delete(oldest.value);
			}
		}
		this.data.set(key, value);
	}

	clear(): void {
		this.data.clear();
	}

	get size(): number {
		return this.data.size;
	}
}
