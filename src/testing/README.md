# Andamiaje de tests

Aquí no hay ni una aserción, y es a propósito: el programa prohíbe que un modelo
escriba las pruebas del código que él mismo generó, porque afirmaría el
comportamiento que produjo, errores incluidos. Esto son las piezas para que
escribir las tuyas cueste poco.

**Nada de esto se compila al `dist` ni cuenta para la cobertura.**

## Qué hay

| Fichero | Para qué |
|---|---|
| `build-service.ts` | Compila cualquier servicio con sus dependencias sustituidas |
| `prisma.mock.ts` | Mock profundo de `PrismaService` con las **dos** formas de `$transaction` |
| `factories.ts` | Constructores de filas válidas según el modelo, con sobreescritura |
| `http.ts` | `ArgumentsHost` y `ExecutionContext` falsos, con grabadora de respuesta |

## `buildService`

Sustituye `PrismaService`, `StorageService`, `MailService`, `JwtService`,
`TokenService` y `ConfigService`. Deja **reales** `PasswordService`, porque es
puro y hashear de verdad es lo que hace creíble un test de `signIn`, y
`ProductsService`, porque `SkusService` e `ImagesService` dependen de él.

El objetivo se registra **después** de los dobles, así que
`buildService(TokenService)` recibe el real y no su mock. Comprobado.

```ts
const h = await buildService(CategoriesService);
resetPrismaMock(h.prisma);

h.prisma.category.findUnique.mockResolvedValue(aCategory({ name: 'Tees' }));
// aquí van tus aserciones
```

Devuelve `{ service, prisma, storage, mail, tokens, jwt, config }`. `config` es
un objeto normal: escribir en él cambia lo que ve el servicio.

Los siete objetivos que hacen falta montan sin providers extra:
`AuthService`, `TokenService`, `PasswordService`, `CategoriesService`,
`ProductsService`, `SkusService`, `ImagesService`.

## Factorías

`aUser` · `anUnverifiedUser` · `aManager` · `aCategory` · `aProduct` · `anImage` ·
`aSku` · `aFullProduct` · `aMulterFile` · `aOneTimeToken` · `aRefreshToken`

Los valores por defecto respetan los CHECK de la base: `price > 0`,
`reserved <= stock`, un GUEST nunca verificado, un fichero que pasa las tres
validaciones de imagen. Si un test necesita una fila que la base rechazaría,
tiene que decirlo en la sobreescritura, y eso deja constancia de que es a
propósito.

`aFullProduct` monta el anidamiento de `FULL_INCLUDE`, incluida la envoltura
`{ category }` de la tabla puente, que es donde todo el mundo se equivoca.

## `http.ts`

Para el filtro de problemas:

```ts
const { host, recorded } = anArgumentsHost({ url: '/api/v1/pedidos' });
new ProblemDetailsFilter().catch(laExcepcion, host);
// recorded.status, recorded.contentType, recorded.body, recorded.headers
```

Para un guard, `anExecutionContext({ user, handler, controller })`. `handler` y
`controller` importan: `Reflector.getAllAndOverride` lee la metadata de los dos,
así que hay que pasarle el método y la clase reales que llevan el decorador.

---

## Lo que conviene cubrir

No es una lista cerrada; sale del contrato y de `MATRIZ-AUTORIZACION.md`.

**`auth.service.ts`** — 322 líneas a cero, la mitad del trabajo que falta.

- **`signIn` con contraseña mala sobre cuenta sin verificar da 401, no 403.** Es
  lo que impide que el 403 sea un oráculo de enumeración. Un test que sólo mire
  el código de respuesta no lo protege.
- `signUp` sobre cuenta verificada manda recordatorio y **no toca la base**.
- `signUp` sobre cuenta sin verificar consume el token vivo antes de crear el
  nuevo. Sin eso, el único parcial revienta.
- `confirmEmailVerification` mueve `pendingPasswordHash` a `users`, marca
  verificado y pone ACTIVE, **en la misma transacción**.

**`token.service.ts`** — `rotate` tiene tres caminos, y el que vale es que un
token con `revokedAt` **revoca la familia entera**, no sólo ese token.

**`problem-details.filter.ts`** — `message` array y `message` cadena tienen que
producir los dos un `detail` que sea cadena. Y un `Error` pelado sale como 500
genérico **sin que su mensaje aparezca** en la respuesta.

**`skus.service.ts`** — `imageId: null` desengancha y `imageId: undefined` no
toca nada: son ramas distintas.

**`images.service.ts`** — el producto se valida antes de subir a S3, así que con
producto inexistente `storage.put` no debe haberse llamado. Y en el borrado, la
fila cae antes que el objeto.

**`products.service.ts`** — faltan `create`, `update` y `remove`.

## Y una que vale por todas

El programa cierra este bloque con un criterio concreto: haber escrito **un test
que falle** contra código generado, y haber arreglado **el código, no el test**.

Ya está cumplido: el `PoliciesGuard` autorizaba por nombre de sujeto y se
corrigió el guard, no la prueba.
