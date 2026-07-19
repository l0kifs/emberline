/**
 * Identifier-token overlap: the cheap ranking primitive.
 *
 * Shared by the cross-file ring buffer and the accepted-example store. The ring
 * ranks on every keystroke, so its scoring has to be effectively free -- that is
 * why it was never embedding-based. The example store now shares the mechanism
 * (see docs/typescript-migration.md §1.4); if embeddings return, they return
 * behind `ExampleSource`, not here.
 */

const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

/**
 * Identifier-ish tokens, minimum length 3.
 *
 * `matchAll` clones the regex internally, so the module-level `g` flag carries no
 * `lastIndex` state between calls.
 */
export function tokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const m of text.matchAll(TOKEN_RE)) {
		out.add(m[0]);
	}
	return out;
}

/** Jaccard over identifier-ish tokens. */
export function similarity(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) {
		return 0;
	}
	// Iterate the smaller set: intersection cost tracks the smaller side.
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let inter = 0;
	for (const t of small) {
		if (large.has(t)) {
			inter++;
		}
	}
	if (inter === 0) {
		return 0;
	}
	return inter / (a.size + b.size - inter);
}
