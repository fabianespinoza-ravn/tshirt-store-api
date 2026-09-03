// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      // Encodes the conventions this repo already follows: camelCase
      // everywhere by default, PascalCase for type-like symbols and enum
      // members, and two named exceptions at module scope — SCREAMING_SNAKE
      // for true constants (MAX_IMAGE_BYTES, VERIFICATION_TTL_MS) and
      // PascalCase for decorator factories used as `@Decorator()` (CurrentUser,
      // Public, CheckPolicies, RateLimited) and for the `Problems` catalog.
      // Class/object/interface properties are left unchecked because several
      // of them mirror an external contract verbatim (EnvironmentVariables'
      // env-var names, DTO fields, Prisma payload shapes).
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'default',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['PascalCase'],
        },
        {
          selector: 'variable',
          modifiers: ['global', 'const'],
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
        },
        // `ApiProblems` is a decorator factory written as a function
        // declaration rather than a const arrow function, but it plays the
        // same role as `CurrentUser`/`Public`/`CheckPolicies`/`RateLimited`.
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase'],
        },
        {
          selector: ['classProperty', 'objectLiteralProperty', 'typeProperty'],
          format: null,
        },
      ],
    },
  },
  {
    // `expect(mock.metodo).not.toHaveBeenCalled()` dispara unbound-method, que
    // aquí es un falso positivo: lo que se pasa es un espía de Jest, no un
    // método de clase que vaya a invocarse con el `this` equivocado. La propia
    // documentación de typescript-eslint recomienda apagarlo en los tests.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
