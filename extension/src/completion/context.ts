/**
 * Cursor context extraction.
 *
 * Pure string work, deliberately free of `vscode` types so it can be tested
 * without an extension host.
 */

export interface CursorContext {
	prefix: string;
	suffix: string;
}

export function extractContext(
	text: string,
	offset: number,
	maxPrefixChars: number,
	maxSuffixChars: number,
): CursorContext {
	// Keep the tail of the prefix and the head of the suffix: the text adjacent to
	// the cursor is what carries the signal, and llama.cpp clamps the window anyway.
	const prefixStart = Math.max(0, offset - maxPrefixChars);
	const suffixEnd = Math.min(text.length, offset + maxSuffixChars);
	return {
		prefix: text.slice(prefixStart, offset),
		suffix: text.slice(offset, suffixEnd),
	};
}

/**
 * Whether a mid-line cursor should suppress an automatic completion.
 *
 * Completing with substantial code still to the right of the cursor almost always
 * produces something unusable. llama.vim gates on 8 characters; the idea is to
 * not ask, rather than to ask faster.
 */
export function shouldSuppressMidLine(
	lineText: string,
	character: number,
	maxLineSuffixChars: number,
): boolean {
	const rest = lineText.slice(character).trim();
	return rest.length > maxLineSuffixChars;
}
