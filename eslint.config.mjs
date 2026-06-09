// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

export default tseslint.config(
  // Ignore compiled output and deps
  { ignores: ['out/**', 'node_modules/**', 'dist/**'] },

  // Base JS rules (no-undef, no-unused-vars, etc.)
  eslint.configs.recommended,

  // TypeScript-aware rules on top (also disables base rules that TS already handles)
  tseslint.configs.recommended,

  // Turn off any ESLint rules that would conflict with Prettier's formatting
  prettierConfig,

  // Project-specific overrides
  {
    rules: {
      // Allow _-prefixed identifiers to be "unused" — common for destructuring leftovers
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Warn on `any` rather than error — a few legitimate uses exist (native bindings, etc.)
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  }
)
