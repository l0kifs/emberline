import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: tsparser,
			ecmaVersion: 2022,
			sourceType: 'module',
		},
		plugins: { '@typescript-eslint': tseslint },
		rules: {
			curly: 'warn',
			eqeqeq: 'warn',
			'no-throw-literal': 'warn',
			semi: 'warn',
			'@typescript-eslint/no-floating-promises': 'off',
		},
	},
];
