import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	// Top level only, deliberately not '**': out/test/engine/ holds the sidecar's
	// tests, which use node:test and would break under Mocha's tdd interface.
	// Those run via `npm run test:engine`, outside Electron -- the engine imports
	// no `vscode`, so it does not need an extension host.
	files: 'out/test/*.test.js',
	mocha: {
		// A cold completion is ~1s on Apple Silicon; the model may also need warming.
		timeout: 60000,
	},
});
