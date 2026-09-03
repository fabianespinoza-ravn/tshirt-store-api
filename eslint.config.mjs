// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// CLAUDE.md: a string literal that duplicates an enum value is a finding.
// The values come from schema.prisma at lint time, so the list can't drift
// from the schema, plus those of `NodeEnv` (src/config/env.validation.ts),
// the one enum the code declares itself. `:not(TSEnumMember) >` leaves the
// enum's own initialisers alone.
const prismaSchema = readFileSync(
  join(import.meta.dirname, 'prisma/schema.prisma'),
  'utf8',
);
const enumValues = new Set([
  ...[...prismaSchema.matchAll(/^enum\s+\w+\s*\{([^}]*)\}/gm)].flatMap(
    ([, body]) =>
      body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\w+$/.test(line)),
  ),
  'development',
  'test',
  'production',
]);
const enumLiteral = {
  selector: `:not(TSEnumMember) > Literal[value=/^(${[...enumValues].join('|')})$/]`,
  message:
    'Use the enum member instead of a string literal that duplicates its value.',
};

// Outside src/common an error is thrown as
// `new ProblemException(Problems.x, detail)`, never as one of Nest's own
// exceptions, so the problem-details filter serves the RFC 9457 document the
// contract declares instead of guessing one from a status code.
const nestExceptions = [
  'HttpException',
  'BadGatewayException',
  'BadRequestException',
  'ConflictException',
  'ForbiddenException',
  'GatewayTimeoutException',
  'GoneException',
  'HttpVersionNotSupportedException',
  'ImATeapotException',
  'InternalServerErrorException',
  'MethodNotAllowedException',
  'MisdirectedException',
  'NotAcceptableException',
  'NotFoundException',
  'NotImplementedException',
  'PayloadTooLargeException',
  'PreconditionFailedException',
  'RequestTimeoutException',
  'ServiceUnavailableException',
  'UnauthorizedException',
  'UnprocessableEntityException',
  'UnsupportedMediaTypeException',
];
const responseStatus = {
  selector:
    "CallExpression[callee.object.name=/^(res|response)$/][callee.property.name='status']",
  message:
    'src/common/filters/problem-details.filter.ts is the only place that sets a status by hand; throw a ProblemException and let the filter shape the response.',
};

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
      'no-restricted-syntax': ['error', enumLiteral],
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
    // src/common owns the Problems catalog and the filter; everything else
    // goes through them.
    files: ['src/**/*.ts', 'test/**/*.ts'],
    ignores: ['src/common/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/common',
              importNames: nestExceptions,
              message:
                'Throw `new ProblemException(Problems.x, detail)` (src/common/problem) instead; the problem-details filter is the only place an error response is shaped.',
            },
          ],
        },
      ],
      'no-restricted-syntax': ['error', enumLiteral, responseStatus],
    },
  },
  {
    // `expect(mock.method).not.toHaveBeenCalled()` triggers unbound-method, which
    // is a false positive here: what's passed is a Jest spy, not a class method
    // that would get invoked with the wrong `this`. typescript-eslint's own
    // documentation recommends turning it off in tests.
    files: ['**/*.spec.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
