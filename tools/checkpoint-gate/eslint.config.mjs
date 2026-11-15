// The checkpoint gate's code-health rules, for the frontend, the admin portal
// and the backend alike (TypeScript and JavaScript).
//
// These are not style rules. Each one marks code that is hard to review, test
// or change safely. The gate runs them on the PR and on its base and fails only
// on violations the PR ADDS, so existing debt is reported, never blamed on the
// next person to touch the file.
//
// Types and undefined names are each app's own job (`tsc --noEmit`, `npm run
// lint`); this file only measures shape. Rule names that disable comments in
// the repo refer to are stubbed, so those comments don't turn into errors here.

import tseslint from 'typescript-eslint';

const noop = { create: () => ({}) };

// `<Icon />` uses Icon. Marks JSX names used for parsers that don't track JSX.
const jsxUsesVars = {
  create(context) {
    const root = (n) => (n.type === 'JSXMemberExpression' ? root(n.object) : n);
    return {
      JSXOpeningElement(node) {
        const id = root(node.name);
        if (id.type === 'JSXIdentifier' && !/^[a-z]/.test(id.name)) context.sourceCode.markVariableAsUsed(id.name, node);
        else if (id.type === 'JSXIdentifier' && node.name.type === 'JSXMemberExpression') context.sourceCode.markVariableAsUsed(id.name, node);
      },
    };
  },
};

// typescript-eslint, plus rule names that newer versions dropped but old
// disable comments still mention.
const tsPlugin = { ...tseslint.plugin, rules: { 'no-var-requires': noop, ...tseslint.plugin.rules } };

export default [
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': { rules: { 'exhaustive-deps': noop, 'rules-of-hooks': noop } },
      '@next/next': { rules: { 'no-img-element': noop, 'no-html-link-for-pages': noop, 'no-page-custom-font': noop, 'no-sync-scripts': noop } },
      gate: { rules: { 'jsx-uses-vars': jsxUsesVars } },
    },
    rules: {
      'gate/jsx-uses-vars': 'error',
      // Branches in one function. Past 20 nobody can hold every path in their head.
      complexity: ['error', 20],
      // Nesting depth inside a function.
      'max-depth': ['error', 5],
      // A function wanting more than 5 inputs wants an object.
      'max-params': ['error', 5],
      // React screens run long; past this, split the screen into parts.
      'max-lines-per-function': ['error', { max: 250, skipBlankLines: true, skipComments: true }],
      'max-nested-callbacks': ['error', 4],
      // Dead code inside a file: values made and never read, code after a return.
      // The TypeScript version understands type-only use (interfaces, generics).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'after-used', ignoreRestSiblings: true, caughtErrors: 'none',
        varsIgnorePattern: '^(_|React$)', argsIgnorePattern: '^_',
      }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
    },
  },
  {
    // A test file is one long describe() of nested callbacks by design.
    files: ['**/test/**', '**/tests/**', '**/*.test.*', '**/*.spec.*'],
    rules: { 'max-lines-per-function': 'off', 'max-nested-callbacks': 'off' },
  },
];
