import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	mocha: {
		// A cold completion is ~1s on Apple Silicon; the model may also need warming.
		timeout: 60000,
	},
});
