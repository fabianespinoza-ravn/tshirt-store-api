# Test scaffolding

There isn't a single assertion here, and that's on purpose: the program
forbids a model from writing the tests for code it generated itself, because
it would just be asserting the behaviour it produced, bugs included. These
are the pieces that make writing your own cheap.

**None of this compiles into `dist` or counts toward coverage.**

## What's here

| File | What for |
|---|---|
| `build-service.ts` | Compiles any service with its dependencies replaced |
| `prisma.mock.ts` | Deep mock of `PrismaService` with **both** shapes of `$transaction` |
| `factories.ts` | Builders for valid rows per the model, with overrides |
| `http.ts` | Fake `ArgumentsHost` and `ExecutionContext`, with a response recorder |

## `buildService`

Replaces `PrismaService`, `StorageService`, `MailService`, `JwtService`,
`TokenService` and `ConfigService`. Keeps `PasswordService` **real**, because
it's pure and hashing for real is what makes a `signIn` test believable, and
`ProductsService`, because `SkusService` and `ImagesService` depend on it.

The target is registered **after** the doubles, so `buildService(TokenService)`
gets the real one and not its mock. Verified.

```ts
const h = await buildService(CategoriesService);
resetPrismaMock(h.prisma);

h.prisma.category.findUnique.mockResolvedValue(aCategory({ name: 'Tees' }));
// your assertions go here
```

Returns `{ service, prisma, storage, mail, tokens, jwt, config }`. `config` is
a plain object: writing to it changes what the service sees.

The seven targets that are needed mount with no extra providers:
`AuthService`, `TokenService`, `PasswordService`, `CategoriesService`,
`ProductsService`, `SkusService`, `ImagesService`.

## Factories

`aUser` · `anUnverifiedUser` · `aManager` · `aCategory` · `aProduct` · `anImage` ·
`aSku` · `aFullProduct` · `aMulterFile` · `aOneTimeToken` · `aRefreshToken`

The default values respect the database's CHECKs: `price > 0`,
`reserved <= stock`, a GUEST is never verified, a file that passes the three
image validations. If a test needs a row the database would reject, it has
to say so in the override, and that leaves a record that it's deliberate.

`aFullProduct` assembles `FULL_INCLUDE`'s nesting, including the join table's
`{ category }` wrapper, which is where everyone gets it wrong.

## `http.ts`

For the problem filter:

```ts
const { host, recorded } = anArgumentsHost({ url: '/api/v1/orders' });
new ProblemDetailsFilter().catch(theException, host);
// recorded.status, recorded.contentType, recorded.body, recorded.headers
```

For a guard, `anExecutionContext({ user, handler, controller })`. `handler`
and `controller` matter: `Reflector.getAllAndOverride` reads metadata from
both, so the real method and class carrying the decorator have to be passed
in.

---

## What's worth covering

This isn't a closed list; it comes from the contract and from
`MATRIZ-AUTORIZACION.md`.

**`auth.service.ts`** — 322 lines at zero, half of the remaining work.

- **`signIn` with a bad password on an unverified account returns 401, not
  403.** That's what keeps 403 from being an enumeration oracle. A test that
  only checks the response code doesn't protect it.
- `signUp` on a verified account sends a reminder and **never touches the
  database**.
- `signUp` on an unverified account consumes the live token before creating
  the new one. Without that, the partial unique index blows up.
- `confirmEmailVerification` moves `pendingPasswordHash` to `users`, marks it
  verified and sets ACTIVE, **in the same transaction**.

**`token.service.ts`** — `rotate` has three paths, and the one that matters is
that a token with `revokedAt` **revokes the whole family**, not just that
token.

**`problem-details.filter.ts`** — an array `message` and a string `message`
both have to produce a string `detail`. And a bare `Error` comes out as a
generic 500 **without its message showing up** in the response.

**`skus.service.ts`** — `imageId: null` detaches and `imageId: undefined`
touches nothing: they're different branches.

**`images.service.ts`** — the product is validated before uploading to S3, so
with a nonexistent product `storage.put` must never have been called. And on
delete, the row goes before the object.

**`products.service.ts`** — `create`, `update` and `remove` are still missing.

## And the one that's worth all the others

The program closes this block with a concrete requirement: having written
**a test that fails** against generated code, and having fixed **the code,
not the test**.

Already done: `PoliciesGuard` was authorizing by subject name, and it was the
guard that got fixed, not the test.
