/**
 * Cleanup applied to raw model output before it becomes ghost text.
 *
 * FIM models routinely run past the useful completion and start re-emitting text
 * that already exists after the cursor. Rendering that produces visibly duplicated
 * code the moment the user accepts, so it has to be trimmed here rather than in the
 * extension -- the extension is deliberately dumb.
 */

/**
 * Whether the last `size` code units of `text` equal the first `size` of `suffix`.
 *
 * Compared by code unit, without slicing, so a candidate length costs no
 * allocation. This is what lets the scan below be uncapped: the previous version
 * sliced both operands per iteration and capped the scan at 200 to bound that, but
 * the cap was a cliff, not a graceful cutoff -- an overlap one character past it
 * was not partially stripped, it was left in full, rendering visibly duplicated
 * code on accept.
 */
function overlapsAt(text: string, suffix: string, size: number): boolean {
	const base = text.length - size;
	for (let i = 0; i < size; i++) {
		if (text.charCodeAt(base + i) !== suffix.charCodeAt(i)) {
			return false;
		}
	}
	return true;
}

/**
 * Drop a tail of `text` that already appears at the head of `suffix`.
 *
 * The classic case: cursor sits before `)`, the model helpfully emits `)` too,
 * and accepting yields `))`. Longest overlap wins.
 *
 * Compares by UTF-16 code unit where Python compared by code point. That differs
 * only when an astral character straddles the overlap boundary exactly; do not
 * "fix" it with `Array.from`, which would add O(n) allocations per call for no
 * reachable benefit. Runs once per generation, not per keystroke.
 */
function stripSuffixOverlap(text: string, suffix: string): string {
	if (!text || !suffix) {
		return text;
	}
	for (let size = Math.min(text.length, suffix.length); size > 0; size--) {
		if (overlapsAt(text, suffix, size)) {
			return text.slice(0, text.length - size);
		}
	}
	return text;
}

export function trimCompletion(text: string, suffix = ''): string {
	if (!text) {
		return '';
	}

	// A completion that is only whitespace is noise; ghost text for it is worse
	// than nothing because it swallows the Tab key.
	if (!text.trim()) {
		return '';
	}

	let out = stripSuffixOverlap(text, suffix);

	// Trailing blank lines never help: the editor already has them, and they make
	// the ghost text render as an empty gap.
	out = out.replace(/\n+$/, '');
	if (!out.trim()) {
		return '';
	}

	return out;
}
