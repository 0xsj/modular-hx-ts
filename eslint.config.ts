import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Lint. The structural rules S1-S10 are not here — they are import-graph rules
 * and live in `.dependency-cruiser.cjs`, which `make lint` runs alongside this.
 * The semantic M rules are AST rules and live in `tests/rules/`. Each class of
 * rule sits in the tool that can actually express it.
 */
export default defineConfig([
  globalIgnores([
    'dist/**',
    // These trees violate the architecture on purpose, so that
    // tests/rules/arch.test.ts can prove each rule fires.
    'tests/rules/fixtures/**',
  ]),

  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.cjs', '**/*.mjs'],
    extends: [
      js.configs.recommended,
      // Type-aware from the start. The rules that catch real bugs — floating
      // promises, unsafe any, misused promises — all need type information,
      // and retrofitting them onto a grown codebase never happens.
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // verbatimModuleSyntax erases only what is marked as a type, so the
      // marking has to be consistent or the emit changes under you.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      // An unused parameter is usually a signature that outgrew its body, but
      // a leading underscore says "required by the contract, not needed here".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Config files that are CommonJS by necessity are not part of the program,
  // so there are no types to check them against.
  {
    files: ['**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
]);
