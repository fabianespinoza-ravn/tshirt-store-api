# Lo que Prisma no puede expresar

`schema.prisma` es una traducción del ERD de la Semana 1, pero **tres clases de objeto no
tienen sintaxis en Prisma** y hay que escribirlas a mano dentro de una migración.

Cómo se hace: se genera la migración vacía y se edita antes de aplicarla.

```bash
npx prisma migrate dev --create-only --name partial_indexes_and_checks
# edita el .sql generado, añade lo de abajo, y luego:
npx prisma migrate dev
```

Si esto no se hace, **el esquema compila y el modelo pierde sus garantías en silencio**: los
únicos parciales pasan a comportarse como únicos totales o a no existir, y ninguna de las
invariantes de los CHECK se cumple.

---

## 1. Los seis índices únicos parciales

El ERD los declara con el prefijo `uq_` y el sufijo `_partial`, y su predicado vive en la nota
de cada tabla. Ninguno es expresable con `@@unique`, porque Prisma no admite predicado.

| Nombre | Tabla | Definición |
|---|---|---|
| `uq_users_email_live_partial` | `users` | `UNIQUE (email) WHERE deleted_at IS NULL` |
| `uq_email_verification_tokens_live_partial` | `email_verification_tokens` | `UNIQUE (user_id) WHERE consumed_at IS NULL` |
| `uq_carts_user_active_partial` | `carts` | `UNIQUE (user_id) WHERE status = 'ACTIVE'` |
| `uq_payments_order_succeeded_partial` | `payments` | `UNIQUE (order_id) WHERE status = 'SUCCEEDED'` |
| `uq_payment_links_sku_active_partial` | `payment_links` | `UNIQUE (sku_id) WHERE is_active` |
| `uq_promo_codes_code_live_partial` | `promo_codes` | `UNIQUE (code) WHERE deleted_at IS NULL` |

Cada uno sostiene una decisión del modelo. `uq_carts_user_active_partial` es lo que garantiza un
solo carrito activo por usuario; `uq_payment_links_sku_active_partial` es lo que hace segura la
creación *get-or-create* bajo concurrencia; `uq_payments_order_succeeded_partial` es un pago
liquidado por pedido.

## 2. El índice parcial de la barrida

| Nombre | Tabla | Definición |
|---|---|---|
| `idx_orders_pending_expires_partial` | `orders` | `(expires_at) WHERE status = 'PENDING'` |

No es único. Es el índice que usa la barrida que caduca reservas.

## 3. Los CHECK

Copiados de las notas del ERD, que son la fuente de verdad.

**`users`**
- `password_hash IS NOT NULL OR email_verified_at IS NULL`
- `state = 'ACTIVE' OR email_verified_at IS NULL`

**`skus`**
- `price > 0`, `stock >= 0`, `reserved >= 0`, `reserved <= stock`, `restock_cycle >= 0`

**`cart_items`**
- `quantity > 0`

**`orders`**
- `total = subtotal - order_discount_amount`
- `subtotal >= 0`, `order_discount_amount >= 0`
- `(delivered_by_id IS NULL) = (delivered_at IS NULL)`

**`order_items`**
- `quantity > 0`, `unit_price >= 0`

**`payment_links`**
- `unit_price_at_creation > 0`

**`promo_codes`**
- `discount_value > 0`
- `discount_value <= 100 WHEN type = 'PERCENTAGE'`
- `usage_count >= 0`, `usage_reserved >= 0`, `usage_limit >= 0`
- `usage_count + usage_reserved <= usage_limit`
- `minimum_purchase_amount >= 0` cuando no es nulo
- `expires_at > created_at`

**`stock_notifications`**
- `(sent_at IS NOT NULL) = (status = 'SENT')`

---

## Dos cosas que conviene comprobar al aplicar

**Los UUID los genera la aplicación, no la base.** La cabecera del ERD lo dice: *"Todos los UUID
se generan como UUIDv7 en Prisma, no mediante un default SQL."* Por eso ningún `id` lleva
`@default` en el esquema. Si un `INSERT` falla por id nulo, falta el generador en la aplicación,
no un default en la migración.

**La FK compuesta de `skus` ya está en el esquema.** `image` referencia
`ProductImage(id, productId)`, que es lo que impide que una variante apunte a la imagen de otro
producto. Esa sí la expresa Prisma, gracias al `@@unique([id, productId])` de `product_images`.
