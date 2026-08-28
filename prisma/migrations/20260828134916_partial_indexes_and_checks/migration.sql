-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('MANAGER', 'CLIENT', 'DELIVERY');

-- CreateEnum
CREATE TYPE "user_state" AS ENUM ('GUEST', 'ACTIVE');

-- CreateEnum
CREATE TYPE "cart_status" AS ENUM ('ACTIVE', 'CHECKED_OUT');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('PENDING', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('PAYMENT_INTENT', 'PAYMENT_LINK');

-- CreateEnum
CREATE TYPE "discount_type" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "size" AS ENUM ('XS', 'S', 'M', 'L', 'XL', 'XXL');

-- CreateEnum
CREATE TYPE "color" AS ENUM ('BLACK', 'WHITE', 'RED', 'BLUE', 'GREEN', 'YELLOW', 'GRAY', 'NAVY');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR NOT NULL,
    "password_hash" VARCHAR,
    "role" "user_role" NOT NULL DEFAULT 'CLIENT',
    "state" "user_state" NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR NOT NULL,
    "pending_password_hash" VARCHAR,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "name" VARCHAR NOT NULL,
    "description" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "s3_key" VARCHAR NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skus" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "image_id" UUID,
    "size" "size" NOT NULL,
    "color" "color" NOT NULL,
    "price" INTEGER NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "restock_cycle" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "skus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "cart_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_likes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ,
    "subtotal" INTEGER NOT NULL,
    "order_discount_amount" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "recipient_name" VARCHAR NOT NULL,
    "line1" VARCHAR NOT NULL,
    "line2" VARCHAR,
    "city" VARCHAR NOT NULL,
    "region" VARCHAR,
    "postal_code" VARCHAR NOT NULL,
    "delivered_by_id" UUID,
    "delivered_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "product_name" VARCHAR NOT NULL,
    "unit_price" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "method" "payment_method" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'PENDING',
    "amount" INTEGER NOT NULL,
    "stripe_payment_intent_id" VARCHAR,
    "stripe_checkout_session_id" VARCHAR,
    "stripe_refund_id" VARCHAR,
    "refunded_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_links" (
    "id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "stripe_payment_link_id" VARCHAR NOT NULL,
    "url" VARCHAR NOT NULL,
    "unit_price_at_creation" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" UUID NOT NULL,
    "stripe_event_id" VARCHAR NOT NULL,
    "event_type" VARCHAR NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "status" "order_status" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_codes" (
    "id" UUID NOT NULL,
    "code" VARCHAR NOT NULL,
    "type" "discount_type" NOT NULL,
    "discount_value" INTEGER NOT NULL,
    "minimum_purchase_amount" INTEGER,
    "usage_limit" INTEGER NOT NULL,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "usage_reserved" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promo_code_redemptions" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "promo_code_id" UUID NOT NULL,
    "code_snapshot" VARCHAR NOT NULL,
    "discount_applied" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promo_code_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "restock_cycle" INTEGER NOT NULL,
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "stock_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_refresh_tokens_token_hash" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_refresh_tokens_user_id" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "idx_refresh_tokens_family_id" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_password_reset_tokens_token_hash" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "idx_password_reset_tokens_user_id" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_email_verification_tokens_token_hash" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "uq_categories_name" ON "categories"("name");

-- CreateIndex
CREATE INDEX "idx_products_created_at_id" ON "products"("created_at", "id");

-- CreateIndex
CREATE INDEX "idx_product_categories_category_product" ON "product_categories"("category_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_categories_product_category" ON "product_categories"("product_id", "category_id");

-- CreateIndex
CREATE INDEX "idx_product_images_product_id" ON "product_images"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_images_id_product" ON "product_images"("id", "product_id");

-- CreateIndex
CREATE INDEX "idx_skus_product_id" ON "skus"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_skus_product_size_color" ON "skus"("product_id", "size", "color");

-- CreateIndex
CREATE INDEX "idx_cart_items_sku_id" ON "cart_items"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cart_items_cart_sku" ON "cart_items"("cart_id", "sku_id");

-- CreateIndex
CREATE INDEX "idx_product_likes_product_id" ON "product_likes"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_product_likes_user_product" ON "product_likes"("user_id", "product_id");

-- CreateIndex
CREATE INDEX "idx_orders_user_created_id" ON "orders"("user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "idx_orders_status" ON "orders"("status");

-- CreateIndex
CREATE INDEX "idx_orders_delivered_by" ON "orders"("delivered_by_id");

-- CreateIndex
CREATE INDEX "idx_order_items_order_id" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "idx_order_items_sku_id" ON "order_items"("sku_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payments_stripe_payment_intent_id" ON "payments"("stripe_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payments_stripe_checkout_session_id" ON "payments"("stripe_checkout_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payment_links_stripe_payment_link_id" ON "payment_links"("stripe_payment_link_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_webhook_events_stripe_event_id" ON "webhook_events"("stripe_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_status_history_order_sequence" ON "order_status_history"("order_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "uq_promo_code_redemptions_order" ON "promo_code_redemptions"("order_id");

-- CreateIndex
CREATE INDEX "idx_promo_code_redemptions_promo_code_id" ON "promo_code_redemptions"("promo_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_stock_notifications_user_sku_cycle" ON "stock_notifications"("user_id", "sku_id", "restock_cycle");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skus" ADD CONSTRAINT "skus_image_id_product_id_fkey" FOREIGN KEY ("image_id", "product_id") REFERENCES "product_images"("id", "product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_likes" ADD CONSTRAINT "product_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_likes" ADD CONSTRAINT "product_likes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivered_by_id_fkey" FOREIGN KEY ("delivered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promo_code_redemptions" ADD CONSTRAINT "promo_code_redemptions_promo_code_id_fkey" FOREIGN KEY ("promo_code_id") REFERENCES "promo_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_notifications" ADD CONSTRAINT "stock_notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_notifications" ADD CONSTRAINT "stock_notifications_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "skus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =====================================================================
-- Lo que Prisma no sabe declarar: indices unicos parciales y CHECK.
-- Fuente: prisma/RAW-SQL.md, derivado de las notas del ERD de la Semana 1.
-- =====================================================================
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
