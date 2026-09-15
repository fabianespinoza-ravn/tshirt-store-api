// The declared layout of this repo. This file is the only part of the skill
// that is repo-specific: another repo declares its own shape and the checker
// works unchanged.
//
// The rule, in one sentence: `src/` holds domains, plus `shared/` for what
// crosses them and `testing/` for scaffolding. A domain is either a single
// module or a folder of modules.

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

  // Top-level folders that are not domains.
  reserved: {
    // Code more than one domain imports. A domain's own shared code belongs
    // to that domain, not here.
    shared: 'shared',
    // Test scaffolding; never compiled into dist.
    testing: 'testing',
  },

  // An import that leaves its domain reads better, and survives the next
  // move, when it names the domain instead of counting `../`. Remove this
  // block and the skill leaves every specifier relative.
  //
  // What it does NOT do is wire the resolvers: `tsconfig`'s `paths`, the
  // test runner's mapping and the build's rewrite step stay the author's,
  // because those files carry comments and structure a JSON editor would
  // flatten. The skill reports what is missing and verifies the one failure
  // that is silent — an alias surviving into the build output.
  alias: {
    prefix: '@',
    // Listed rather than inferred, so adding a top-level folder is a
    // decision about whether it deserves an alias.
    of: ['auth', 'catalog', 'checkout', 'platform', 'shared', 'testing'],
  },

  // Each domain's members, used once to compute the migration. The check
  // that keeps the layout afterwards is structural and needs no list: a
  // folder inside a domain is a module or it is the domain's `shared/`.
  //
  // `auth` is absent on purpose — it is a single-module domain, holding its
  // own `auth.module.ts` directly, and there is nothing to gather.
  domains: {
    catalog: {
      members: ['categories', 'products', 'skus', 'images', 'likes'],
      // The view kernel only these five import: it belongs to the domain,
      // not to the repo-wide shared tier where it currently sits.
      shared: 'shared/catalog',
    },
    checkout: {
      members: ['cart', 'orders', 'payments', 'promo-codes'],
    },
    platform: {
      members: ['prisma', 'queue', 'mail', 'storage', 'notifications'],
    },
  },
};
