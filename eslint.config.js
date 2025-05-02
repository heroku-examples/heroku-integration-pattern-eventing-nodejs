import js from '@eslint/js';
import globals from 'globals';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: ['node_modules/', 'docs/refapps/'],
  },
  // Start with recommended ESLint rules
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.nodeBuiltin, // Use nodeBuiltin for ESM
      },
    },
    plugins: {
      // Apply prettier plugin
      prettier: prettierPlugin,
    },
    rules: {
      // Apply prettier rules as ESLint rules
      ...prettierConfig.rules,
      // Report prettier differences as warnings
      'prettier/prettier': 'warn',

      // --- Add some basic standard-like rules manually (can be expanded later) ---
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'], // Enforce === and !==
      curly: ['error', 'multi-line'], // Require braces for multi-line blocks
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off', // Allow console in dev
      'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off', // Allow debugger in dev
    },
  },
];
