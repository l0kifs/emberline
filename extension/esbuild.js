const fs = require('node:fs');
const path = require('node:path');

const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Surfaces esbuild errors in VS Code's problem matcher during watch builds. */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',
	setup(build) {
		build.onStart(() => console.log('[watch] build started'));
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * Modules that must not import `vscode`.
 *
 * For `completion/context.ts` and `client/http.ts` this keeps `unit.test.ts`
 * meaningful. For the engine it is harder: the engine is compiled into a sidecar
 * that has no extension host, so a `vscode` import there fails at runtime -- in a
 * detached process with stdio ignored, which is the worst place to discover it.
 *
 * `external: ['vscode']` cannot catch this; it makes the import survive to
 * runtime by design. Lint cannot either, since every rule here is 'warn' and lint
 * cannot fail the build. So it is a build-time source scan, and it is fatal.
 */
const HOST_FREE = ['src/engine', 'src/wire.ts', 'src/completion/context.ts', 'src/client/http.ts'];
const VSCODE_IMPORT = /(?:from\s+|require\()\s*['"]vscode['"]/;

function filesUnder(target) {
	const abs = path.join(__dirname, target);
	if (!fs.existsSync(abs)) {
		return [];
	}
	if (fs.statSync(abs).isFile()) {
		return [abs];
	}
	return fs
		.readdirSync(abs, { recursive: true })
		.map((entry) => path.join(abs, entry))
		.filter((p) => p.endsWith('.ts') && fs.statSync(p).isFile());
}

/**
 * Runs in onStart so it re-checks on every rebuild: a `vscode` import added
 * mid-session fails the watch build rather than waiting for the next cold
 * `npm run compile`.
 */
const hostFreeGuardPlugin = {
	name: 'host-free-guard',
	setup(build) {
		build.onStart(() => {
			const errors = HOST_FREE.flatMap(filesUnder)
				.filter((p) => VSCODE_IMPORT.test(fs.readFileSync(p, 'utf8')))
				.map((p) => ({
					text:
						`${path.relative(__dirname, p)} imports 'vscode', but must stay ` +
						`free of it (see esbuild.js HOST_FREE)`,
				}));
			return { errors };
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: {
			extension: 'src/extension.ts',
			// The sidecar. Bundled into the VSIX and spawned with
			// ELECTRON_RUN_AS_NODE, so it needs no runtime of its own.
			server: 'src/engine/main.ts',
		},
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outdir: 'dist',
		// Injected by the extension host at runtime; bundling it breaks the extension.
		// Harmless for the server entry, which the host-free guard proves never imports it.
		external: ['vscode'],
		logLevel: 'silent',
		plugins: [hostFreeGuardPlugin, esbuildProblemMatcherPlugin],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
