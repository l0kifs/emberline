/**
 * Cleanup applied to raw model output before it becomes ghost text.
 *
 * FIM models routinely run past the useful completion and start re-emitting text
 * that already exists after the cursor. Rendering that produces visibly duplicated
 * code the moment the user accepts, so it has to be trimmed here rather than in the
 * extension -- the extension is deliberately dumb.
 */

const MAX_OVERLAP_SCAN = 200;

/**
 * Drop a tail of `text` that already appears at the head of `suffix`.
 *
 * The classic case: cursor sits before `)`, the model helpfully emits `)` too,
 * and accepting yields `))`. Longest overlap wins.
 *
 * Compares by UTF-16 code unit where Python compared by code point. That differs
 * only when an astral character straddles the overlap boundary exactly; do not
 * "fix" it with `Array.from`, which would add O(n) allocations per keystroke to
 * the hottest path in the server for no reachable benefit.
 */
function stripSuffixOverlap(text: string, suffix: string): string {
	if (!text || !suffix) {
		return text;
	}
	const head = suffix.slice(0, MAX_OVERLAP_SCAN);
	const limit = Math.min(text.length, head.length);
	for (let size = limit; size > 0; size--) {
		if (text.slice(text.length - size) === head.slice(0, size)) {
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
