# Matriz de autorización

Extraída de `W2-API/openapi.yaml` en `1.0.1`, las 38 operaciones, sin excepciones. **Esto no es un
modelo de autorización**: es tu contrato reordenado por quién puede hacer qué, que es la materia
prima de la que sale la ability. El modelo lo escribes tú.

La columna de códigos es literal, la de rol sale de la descripción de cada operación.

---

## Las tres zonas

| Zona | Cuántas | Qué implica |
|---|---|---|
| **Pública** | 10 | `security: []`. El guard global tiene que dejarlas pasar, y ese es el uso de `@Public()` |
| **Autenticación opcional** | 1 | `getProduct`. Acepta anónimo y ensancha la respuesta para manager |
| **Autenticada** | 27 | Token obligatorio. 23 declaran 403; las otras 4 merecen mirarse |

---

## Autenticación

| Operación | Ruta | Quién | Códigos |
|---|---|---|---|
| `signUp` | `POST /auth/sign-up` | público | 201 400 429 500 |
| `signIn` | `POST /auth/sign-in` | público | 200 400 401 403 429 500 |
| `forgotPassword` | `POST /auth/forgot-password` | público | 202 400 429 500 |
| `resetPassword` | `POST /auth/reset-password` | público | 204 400 404 429 500 |
| `resendEmailVerification` | `POST /auth/email-verifications` | público | 202 400 429 500 |
| `confirmEmailVerification` | `POST /auth/email-verifications/confirm` | público | 204 400 404 500 |
| `refreshSession` | `POST /auth/refresh` | cookie de refresco | 200 401 500 |
| `signOut` | `POST /auth/sign-out` | **bearer + cookie**, los dos | 204 401 500 |
| `changePassword` | `PATCH /auth/password` | cualquier autenticado | 204 400 401 500 |

El 403 de `signIn` no es de rol: es `EmailNotVerified`. No lo mezcles con los demás.

## Catálogo

| Operación | Ruta | Quién | Códigos |
|---|---|---|---|
| `listCategories` | `GET /categories` | público | 200 400 500 |
| `createCategory` | `POST /categories` | MANAGER | 201 400 401 403 409 500 |
| `updateCategory` | `PATCH /categories/{categoryId}` | MANAGER | 200 400 401 403 404 409 500 |
| `deleteCategory` | `DELETE /categories/{categoryId}` | MANAGER | 204 401 403 404 409 500 |
| `listProducts` | `GET /products` | público | 200 400 500 |
| `getProduct` | `GET /products/{productId}` | **anónimo o autenticado** | 200 401 404 500 |
| `createProduct` | `POST /products` | MANAGER | 201 400 401 403 404 500 |
| `updateProduct` | `PATCH /products/{productId}` | MANAGER | 200 400 401 403 404 500 |
| `deleteProduct` | `DELETE /products/{productId}` | MANAGER | 204 401 403 404 409 500 |
| `uploadProductImage` | `POST /products/{productId}/images` | MANAGER | 201 400 401 403 404 413 415 500 |
| `deleteProductImage` | `DELETE /products/{productId}/images/{imageId}` | MANAGER | 204 401 403 404 409 500 |
| `createSku` | `POST /products/{productId}/skus` | MANAGER | 201 400 401 403 404 409 500 |
| `updateSku` | `PATCH /skus/{skuId}` | MANAGER | 200 400 401 403 404 409 500 |
| `setProductLike` | `PUT /products/{productId}/like` | **CLIENT** | 200 400 401 403 404 500 |

## Carrito

Las cuatro son **CLIENT only**, y las cuatro declaran 403.

| Operación | Ruta | Códigos |
|---|---|---|
| `getCart` | `GET /cart` | 200 401 403 500 |
| `addCartItem` | `POST /cart/items` | 200 201 400 401 403 404 409 500 |
| `updateCartItem` | `PATCH /cart/items/{cartItemId}` | 200 400 401 403 404 409 500 |
| `removeCartItem` | `DELETE /cart/items/{cartItemId}` | 200 401 403 404 500 |

## Pedidos

| Operación | Ruta | Quién | Códigos |
|---|---|---|---|
| `listOrders` | `GET /orders` | CLIENT propios · MANAGER todos · DELIVERY su alcance | 200 400 401 403 500 |
| `checkout` | `POST /orders` | **CLIENT** | 201 400 401 403 409 500 |
| `getOrder` | `GET /orders/{orderId}` | CLIENT propios · MANAGER todos · DELIVERY su alcance | 200 401 **404** 500 |
| `updateOrderStatus` | `PATCH /orders/{orderId}/status` | MANAGER · CLIENT · DELIVERY, cada uno con destinos distintos | 200 400 401 **403** **404** 409 500 |
| `getGuestOrder` | `GET /guest-orders/{orderId}` | público, la URL es la credencial | 200 404 500 |

El alcance de DELIVERY: cualquier pedido **SHIPPED**, más los **DELIVERED** que entregó él.

Los destinos permitidos en `updateOrderStatus`:

| Rol | Destino | Desde |
|---|---|---|
| MANAGER | `PROCESSING`, luego `SHIPPED` | `PAID` |
| CLIENT | `CANCELLED` | propio y no enviado |
| DELIVERY | `DELIVERED` | `SHIPPED` |

## Enlaces de pago, webhooks y promociones

| Operación | Ruta | Quién | Códigos |
|---|---|---|---|
| `createPaymentLink` | `POST /payment-links` | MANAGER | 200 201 400 401 403 404 500 |
| `receiveStripeEvent` | `POST /webhooks/stripe` | Stripe, por firma | 200 400 500 |
| `listPromoCodes` | `GET /promo-codes` | MANAGER | 200 400 401 403 500 |
| `createPromoCode` | `POST /promo-codes` | MANAGER | 201 400 401 403 409 500 |
| `updatePromoCode` | `PATCH /promo-codes/{promoCodeId}` | MANAGER | 200 400 401 403 404 409 500 |
| `validatePromoCode` | `POST /promo-codes/validate` | **CLIENT** | 200 400 401 403 409 500 |

---

# Las cuatro filas que rompen el patrón

Son las que hay que mirar dos veces, y salen de contar códigos, no de opinar.

**1. `getOrder` es la única ruta con alcance por rol que NO declara 403.** Las otras tres sin 403
(`signOut`, `refreshSession`, `changePassword`) no lo necesitan porque cualquier rol autenticado
puede hacerlas. En `getOrder` la ausencia es deliberada: un pedido ajeno da **404**, para que el
código no sirva para enumerar identificadores.

**2. `updateOrderStatus` declara 403 y 404 sobre el mismo recurso.** 403 por rol equivocado, 409 por
transición inválida, 404 por pedido ajeno. Es la única operación del contrato que necesita las tres
respuestas distintas, y es donde se esconde el fallo del que avisa el programa.

**3. `getProduct` acepta anónimo y no declara 403.** Un producto inactivo es 404 para el cliente y
200 para el manager. **La visibilidad no es un permiso aquí, es una condición sobre la fila.**

**4. `setProductLike` es CLIENT only y un manager recibe 403.** Junto con las cuatro del carrito y
`checkout`, son las seis operaciones que un `can('manage', 'all')` para MANAGER rompería en
silencio.

---

# Lo que esta tabla te plantea

No son respuestas. Son las decisiones que la matriz deja a la vista.

**Los sujetos que aparecen.** `Category`, `Product`, `ProductImage`, `Sku`, `ProductLike`, `Cart`,
`CartItem`, `Order`, `PaymentLink`, `PromoCode`. Diez, y ninguno es `User`: no hay operación que
lea o escriba otro usuario.

**Dónde la propiedad no está donde parece.** `CartItem` no tiene dueño: lo tiene su `Cart`. Toda
condición sobre una línea de carrito tiene que subir un nivel, y si `@casl/prisma` de la versión que
instales no admite condiciones sobre relaciones, eso cambia la forma del módulo entero.

**Si `update` y `cancel` son acciones distintas.** En `updateOrderStatus` los tres roles hacen cosas
distintas sobre el mismo recurso. Con acciones separadas el 403 por rol sale solo de la ability; con
una sola acción y condiciones, tienes que producirlo tú.

**Qué parte del alcance de DELIVERY es condición y qué parte es estado.** *"Cualquier SHIPPED"* es
una condición sobre la fila. *"Los DELIVERED que entregó él"* es una condición sobre `deliveredById`.
Las dos traducen a un `where`, así que las dos pueden vivir en la ability.

**Las seis operaciones client-only.** Están arriba con el 403 declarado. Enuméralas en positivo.

---

# Lo que NO va en la ability

- **`getGuestOrder`.** La credencial es poseer la URL, no un rol. Modelarlo como ability obliga a
  inventar un sujeto que no existe.
- **`receiveStripeEvent`.** La autoriza una firma HMAC.
- **La transición de estado.** `PAID → PROCESSING → SHIPPED` es una máquina de estados y devuelve
  409. Quién puede intentar qué destino sí es autorización y devuelve 403.
- **La proyección por rol.** Que un manager vea `stock` y `reserved` es serialización. Los permisos
  por campo de CASL sólo restringen, y aquí hace falta añadir.
- **La visibilidad del catálogo.** Activo y no borrado es una condición sobre la fila, no un permiso
  de rol, y por eso `getProduct` devuelve 404 y no 403.
