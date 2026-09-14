// The declared layout of this repo. This file is the only part of the skill
// that is repo-specific: another repo declares its own tiers and the checker
// works unchanged.
//
// The rule this expresses, in one sentence: everything flat under `src/` is
// a Nest module; anything that is not a module lives in `shared/`, except
// the test scaffolding in `testing/`, which never compiles into `dist`.

export const layout = {
  root: 'src',

  // Files allowed to sit loose at the root: entry points and the composition
  // roots they load. Anything else there is a file that never chose a home.
  rootFiles: [
    'main.ts',
    'worker.ts',
    'app.module.ts',
    'worker.module.ts',
    'app.setup.ts',
  ],

  tiers: [
    {
      name: 'module',
      at: 'flat',
      // A folder is a module when it holds the module file Nest loads. The
      // name has to match the folder so the pair is findable from either.
      requires: 'module-file',
    },
    {
      name: 'shared',
      at: 'shared',
      // No module file: these are types, helpers and configuration that
      // modules import, not things Nest mounts.
      requires: 'no-module-file',
    },
    {
      name: 'testing',
      at: 'testing',
      // Exempt: scaffolding, excluded from the build, documented by its own
      // README rather than by this rule.
      requires: 'any',
    },
  ],
};
