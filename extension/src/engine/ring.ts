/**
 * Cross-file context: a ring buffer of chunks from other open files.
 *
 * Modelled on llama.vim's ring buffer, which ranks chunks by plain line-set overlap
 * rather than embeddings. That choice is deliberate and worth preserving: ranking
 * runs on every keystroke, so it has to be effectively free.
 *
 * Chunks land in `/infill`'s `input_extra`, which llama.cpp inserts ahead of the
 * FIM prefix.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { similarity, tokens } from './tokens';
import type { ExtraChunk } from './types';

/** Skip anything bigger; it is a bundle, a lockfile, or generated. */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Rejects invalid UTF-8 instead of substituting U+FFFD.
 *
 * This is load-bearing, and it is the one place where the obvious port is wrong:
 * `fs.readFileSync(p, 'utf8')` never throws on a binary file, it silently fills
 * the text with replacement characters. Python's `read_text(errors="strict")`
 * raised, which is how binaries got skipped -- without `fatal` they would instead
 * be chunked into garbage and fed to the model as cross-file context.
 */
const DECODER = new TextDecoder('utf-8', { fatal: true });

interface Chunk {
	filename: string;
	text: string;
	tokens: Set<string>;
}

interface CachedFile {
	mtimeNs: bigint;
	chunks: Chunk[];
}

export class RingContext {
	private readonly maxChunks: number;
	private readonly chunkLines: number;
	// path -> chunks. Insertion-ordered, so the first key is the least recently
	// used. Keeps us off the disk on every keystroke.
	private readonly files = new Map<string, CachedFile>();
	private readonly maxFiles = 32;

	constructor(opts: { maxChunks?: number; chunkLines?: number } = {}) {
		this.maxChunks = opts.maxChunks ?? 16;
		this.chunkLines = opts.chunkLines ?? 64;
	}

	private chunksFor(p: string): Chunk[] {
		let stat: fs.BigIntStats;
		try {
			// bigint for exact mtime: mtimeMs is a float and loses the resolution
			// this cache check depends on.
			stat = fs.statSync(p, { bigint: true });
		} catch {
			this.files.delete(p);
			return [];
		}
		if (stat.size > BigInt(MAX_FILE_BYTES)) {
			return [];
		}

		const cached = this.files.get(p);
		if (cached !== undefined && cached.mtimeNs === stat.mtimeNs) {
			this.files.delete(p);
			this.files.set(p, cached);
			return cached.chunks;
		}

		let text: string;
		try {
			text = DECODER.decode(fs.readFileSync(p));
		} catch {
			// Binary or unreadable; remember nothing rather than retrying each keystroke.
			this.remember(p, { mtimeNs: stat.mtimeNs, chunks: [] });
			return [];
		}

		const filename = path.basename(p);
		const lines = text.split(/\r\n|\r|\n/);
		const chunks: Chunk[] = [];
		for (let start = 0; start < lines.length; start += this.chunkLines) {
			const body = lines.slice(start, start + this.chunkLines).join('\n');
			if (!body.trim()) {
				continue;
			}
			chunks.push({ filename, text: body, tokens: tokens(body) });
		}

		this.remember(p, { mtimeNs: stat.mtimeNs, chunks });
		return chunks;
	}

	private remember(p: string, entry: CachedFile): void {
		this.files.delete(p);
		this.files.set(p, entry);
		while (this.files.size > this.maxFiles) {
			const oldest = this.files.keys().next();
			if (oldest.done) {
				break;
			}
			this.files.delete(oldest.value);
		}
	}

	/** Rank chunks from other open files against the cursor context. */
	build(args: { prefix: string; currentPath: string; openPaths: string[] }): ExtraChunk[] {
		const query = tokens(args.prefix.slice(-4000));
		if (query.size === 0) {
			return [];
		}

		const scored: Array<{ score: number; chunk: Chunk }> = [];
		for (const p of args.openPaths) {
			if (p === args.currentPath) {
				continue;
			}
			for (const chunk of this.chunksFor(p)) {
				const score = similarity(query, chunk.tokens);
				if (score > 0) {
					scored.push({ score, chunk });
				}
			}
		}

		// Array.prototype.sort is stable (ES2019+), matching Python's sort: ties
		// keep open_paths order rather than shuffling between keystrokes.
		scored.sort((a, b) => b.score - a.score);
		return scored
			.slice(0, this.maxChunks)
			.map(({ chunk }) => ({ filename: chunk.filename, text: chunk.text }));
	}
}
