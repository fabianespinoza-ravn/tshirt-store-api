// Repo-specific: the only file that changes when this skill moves to another
// repo. An empty `watches` array (or a missing file) just skips this layer —
// the other three checks in audit.mjs need no configuration at all.

export const watches = [
  {
    name: 'testing-factories',
    doc: {
      file: 'src/testing/README.md',
      extract: 'backticked-near',
      marker: '## Factories',
    },
    code: {
      file: 'src/testing/factories.ts',
      extract: 'exported-symbols',
    },
  },
  {
    name: 'money-fields',
    doc: {
      file: 'CLAUDE.md',
      extract: 'backticked-near',
      marker: 'Money is an integer number of cents everywhere',
    },
    code: {
      file: 'prisma/schema.prisma',
      extract: 'int-columns-matching',
      pattern: /price|amount|total|value|subtotal|discount/i,
    },
  },
];
