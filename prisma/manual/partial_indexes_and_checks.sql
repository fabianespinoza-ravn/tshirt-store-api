-- Lo que Prisma no sabe declarar. Copiar dentro de la migración generada con
--   npx prisma migrate dev --create-only --name partial_indexes_and_checks
-- y sólo entonces aplicarla. Ver prisma/RAW-SQL.md.
--
-- ATENCIÓN AL ENVOLTORIO: Prisma envuelve en una transacción las migraciones de
-- VARIAS sentencias, y no las de una sola. Este archivo tiene muchas, así que va
-- dentro de una transacción y por eso NO lleva CONCURRENTLY. Sobre una tabla con
-- datos en producción, cada índice concurrente iría en su propio archivo.

-- ---------------------------------------------------------------------------
-- 1. Los seis únicos parciales
-- ---------------------------------------------------------------------------

-- Un correo borrado se libera para reutilizarse, así que el único no es total.
CREATE UNIQUE INDEX "uq_users_email_live_partial"
  ON "users" ("email") WHERE "deleted_at" IS NULL;

-- Como mucho un token vivo por usuario: un alta nueva invalida la anterior.
CREATE UNIQUE INDEX "uq_email_verification_tokens_live_partial"
  ON "email_verification_tokens" ("user_id") WHERE "consumed_at" IS NULL;

-- Exactamente un carrito activo por usuario.
CREATE UNIQUE INDEX "uq_carts_user_active_partial"
  ON "carts" ("user_id") WHERE "status" = 'ACTIVE';

-- Un pago liquidado por pedido. Es la red del hallazgo 4 cuando la clave de
-- idempotencia de Stripe ya ha caducado, pasadas al menos 24 h.
CREATE UNIQUE INDEX "uq_payments_order_succeeded_partial"
  ON "payments" ("order_id") WHERE "status" = 'SUCCEEDED';

-- Como mucho un link vivo por SKU. Es lo que hace seguro el get-or-create bajo
-- concurrencia y lo que limita el abuso del endpoint a un link por SKU.
CREATE UNIQUE INDEX "uq_payment_links_sku_active_partial"
  ON "payment_links" ("sku_id") WHERE "is_active";

-- No hay operación de borrado de cupones, así que en la práctica es total.
CREATE UNIQUE INDEX "uq_promo_codes_code_live_partial"
  ON "promo_codes" ("code") WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 2. El índice parcial de la barrida de reservas caducadas
-- ---------------------------------------------------------------------------

CREATE INDEX "idx_orders_pending_expires_partial"
  ON "orders" ("expires_at") WHERE "status" = 'PENDING';

-- ---------------------------------------------------------------------------
-- 3. Los CHECK
-- ---------------------------------------------------------------------------

-- users: una cuenta verificada siempre tiene credencial, y un GUEST nunca está
-- verificado porque confirmar es justo lo que lo promueve.
ALTER TABLE "users"
  ADD CONSTRAINT "ck_users_verified_has_password"
    CHECK ("password_hash" IS NOT NULL OR "email_verified_at" IS NULL),
  ADD CONSTRAINT "ck_users_guest_never_verified"
    CHECK ("state" = 'ACTIVE' OR "email_verified_at" IS NULL);

-- skus: stock es lo que existe, reserved el bloqueo del checkout, y la
-- disponibilidad es la resta. reserved <= stock es lo que impide sobrevender.
ALTER TABLE "skus"
  ADD CONSTRAINT "ck_skus_price_positive" CHECK ("price" > 0),
  ADD CONSTRAINT "ck_skus_stock_non_negative" CHECK ("stock" >= 0),
  ADD CONSTRAINT "ck_skus_reserved_non_negative" CHECK ("reserved" >= 0),
  ADD CONSTRAINT "ck_skus_reserved_within_stock" CHECK ("reserved" <= "stock"),
  ADD CONSTRAINT "ck_skus_restock_cycle_non_negative" CHECK ("restock_cycle" >= 0);

ALTER TABLE "cart_items"
  ADD CONSTRAINT "ck_cart_items_quantity_positive" CHECK ("quantity" > 0);

-- orders: la aritmética del descuento, y las dos columnas de entrega que
-- registran un solo hecho y deben moverse juntas.
ALTER TABLE "orders"
  ADD CONSTRAINT "ck_orders_total_arithmetic"
    CHECK ("total" = "subtotal" - "order_discount_amount"),
  ADD CONSTRAINT "ck_orders_subtotal_non_negative" CHECK ("subtotal" >= 0),
  ADD CONSTRAINT "ck_orders_discount_non_negative"
    CHECK ("order_discount_amount" >= 0),
  ADD CONSTRAINT "ck_orders_delivery_pair"
    CHECK (("delivered_by_id" IS NULL) = ("delivered_at" IS NULL));

ALTER TABLE "order_items"
  ADD CONSTRAINT "ck_order_items_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "ck_order_items_unit_price_non_negative" CHECK ("unit_price" >= 0);

-- payment_links: es el precio que se honra cuando llega un pago por un link ya
-- desactivado, porque el webhook nunca rechaza.
ALTER TABLE "payment_links"
  ADD CONSTRAINT "ck_payment_links_unit_price_positive"
    CHECK ("unit_price_at_creation" > 0);

-- promo_codes: usage_limit es constante, así que lo disponible es la resta de
-- los otros dos. El tercer CHECK es lo que impide repartir más usos de la cuenta.
ALTER TABLE "promo_codes"
  ADD CONSTRAINT "ck_promo_codes_discount_positive" CHECK ("discount_value" > 0),
  ADD CONSTRAINT "ck_promo_codes_percentage_range"
    CHECK ("type" <> 'PERCENTAGE' OR "discount_value" <= 100),
  ADD CONSTRAINT "ck_promo_codes_usage_count_non_negative" CHECK ("usage_count" >= 0),
  ADD CONSTRAINT "ck_promo_codes_usage_reserved_non_negative"
    CHECK ("usage_reserved" >= 0),
  ADD CONSTRAINT "ck_promo_codes_usage_limit_non_negative" CHECK ("usage_limit" >= 0),
  ADD CONSTRAINT "ck_promo_codes_usage_within_limit"
    CHECK ("usage_count" + "usage_reserved" <= "usage_limit"),
  ADD CONSTRAINT "ck_promo_codes_minimum_non_negative"
    CHECK ("minimum_purchase_amount" IS NULL OR "minimum_purchase_amount" >= 0),
  ADD CONSTRAINT "ck_promo_codes_expiry_after_creation"
    CHECK ("expires_at" > "created_at");

-- stock_notifications: sent_at y status registran un solo hecho, así que la
-- fila contradictoria no es representable.
ALTER TABLE "stock_notifications"
  ADD CONSTRAINT "ck_stock_notifications_sent_pair"
    CHECK (("sent_at" IS NOT NULL) = ("status" = 'SENT'));
