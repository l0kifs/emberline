/**
 * Turns raw editor state into an /infill request.
 *
 * Both context mechanisms land in `input_extra`, which llama.cpp inserts ahead of
 * the FIM prefix: cross-file chunks (ring buffer) and previously accepted
 * completions. They are different features that happen to share a delivery slot.
 */

import { digest } from './cache';
import type { Settings } from './config';
import type { RingContext } from './ring';
import type { ExampleSource, ExtraChunk, InfillRequest } from './types';

export class Assembler {
	constructor(
		private readonly s: Settings,
		private readonly deps: {
			ring: RingContext | null;
			examples: ExampleSource | null;
			log?: (message: string, err: unknown) => void;
		},
	) {}

	/**
	 * Returns the /infill request and a digest of its extra context.
	 *
	 * The digest goes into the cache key, so a cache hit cannot silently serve a
	 * completion built from different surrounding context.
	 */
	async build(args: {
		prefix: string;
		suffix: string;
		languageId: string;
		path: string;
		openPaths: string[];
	}): Promise<{ req: InfillRequest; extraDigest: string }> {
		// Keep the tail of the prefix and the head of the suffix -- the text next to
		// the cursor is what carries signal. llama.cpp clamps to 3:1 of n_batch
		// anyway, so anything beyond this is serialized for nothing.
		const prefix = args.prefix.slice(-this.s.maxPrefixChars);
		const suffix = args.suffix.slice(0, this.s.maxSuffixChars);

		const extra: ExtraChunk[] = [];

		if (this.deps.examples !== null && this.s.examplesEnabled) {
			try {
				const hits = await this.deps.examples.search({
					prefix,
					languageId: args.languageId,
				});
				for (const ex of hits) {
					extra.push({
						filename: 'accepted_example',
						text: `${ex.prefix}${ex.completion}`,
					});
				}
			} catch (err) {
				// Retrieval is an enhancement; never fail a completion over it.
				this.deps.log?.('example retrieval failed, continuing without', err);
			}
		}

		if (this.deps.ring !== null && this.s.ringEnabled) {
			try {
				extra.push(
					...this.deps.ring.build({
						prefix,
						currentPath: args.path,
						openPaths: args.openPaths,
					}),
				);
			} catch (err) {
				this.deps.log?.('ring context failed, continuing without', err);
			}
		}

		const req: InfillRequest = {
			prefix,
			suffix,
			extra,
			n_predict: this.s.nPredict,
			t_max_predict_ms: this.s.tMaxPredictMs,
			temperature: this.s.temperature,
			top_p: this.s.topP,
			top_k: this.s.topK,
		};
		return { req, extraDigest: digest(extra.map((e) => e.text)) };
	}
}
