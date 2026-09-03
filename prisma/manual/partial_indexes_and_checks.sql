-- What Prisma cannot declare. Copy into the migration generated with
--   npx prisma migrate dev --create-only --name partial_indexes_and_checks
-- and only then apply it. See prisma/RAW-SQL.md.
--
-- MIND THE WRAPPER: Prisma wraps multi-statement migrations in a transaction,
-- but not single-statement ones. This file has many, so it runs inside a
-- transaction and that's why it carries NO CONCURRENTLY. On a table with
-- production data, each concurrent index would go in its own file.

-- ---------------------------------------------------------------------------
-- 1. The six partial uniques
-- ---------------------------------------------------------------------------

-- A deleted email is freed up for reuse, so the unique isn't total.
CREATE UNIQUE INDEX "uq_users_email_live_partial"
  ON "users" ("email") WHERE "deleted_at" IS NULL;

-- At most one live token per user: a new sign-up invalidates the previous one.
CREATE UNIQUE INDEX "uq_email_verification_tokens_live_partial"
  ON "email_verification_tokens" ("user_id") WHERE "consumed_at" IS NULL;

-- Exactly one active cart per user.
CREATE UNIQUE INDEX "uq_carts_user_active_partial"
  ON "carts" ("user_id") WHERE "status" = 'ACTIVE';

-- One settled payment per order. This is the safety net for finding 4 when
-- Stripe's idempotency key has already expired, after at least 24 h.
CREATE UNIQUE INDEX "uq_payments_order_succeeded_partial"
  ON "payments" ("order_id") WHERE "status" = 'SUCCEEDED';

-- At most one live link per SKU. This is what makes the get-or-create safe
-- under concurrency and what limits abuse of the endpoint to one link per SKU.
CREATE UNIQUE INDEX "uq_payment_links_sku_active_partial"
  ON "payment_links" ("sku_id") WHERE "is_active";

-- There's no delete operation for coupons, so in practice it's total.
CREATE UNIQUE INDEX "uq_promo_codes_code_live_partial"
  ON "promo_codes" ("code") WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 2. The partial index for the expired-reservation sweep
-- ---------------------------------------------------------------------------

CREATE INDEX "idx_orders_pending_expires_partial"
  ON "orders" ("expires_at") WHERE "status" = 'PENDING';

-- ---------------------------------------------------------------------------
-- 3. The CHECKs
-- ---------------------------------------------------------------------------

-- users: a verified account always has a credential, and a GUEST is never
-- verified because confirming is exactly what promotes it.
ALTER TABLE "users"
  ADD CONSTRAINT "ck_users_verified_has_password"
    CHECK ("password_hash" IS NOT NULL OR "email_verified_at" IS NULL),
  ADD CONSTRAINT "ck_users_guest_never_verified"
    CHECK ("state" = 'ACTIVE' OR "email_verified_at" IS NULL);

-- skus: stock is what exists, reserved is checkout's hold on it, and
-- availability is the subtraction. reserved <= stock is what prevents overselling.
ALTER TABLE "skus"
  ADD CONSTRAINT "ck_skus_price_positive" CHECK ("price" > 0),
  ADD CONSTRAINT "ck_skus_stock_non_negative" CHECK ("stock" >= 0),
  ADD CONSTRAINT "ck_skus_reserved_non_negative" CHECK ("reserved" >= 0),
  ADD CONSTRAINT "ck_skus_reserved_within_stock" CHECK ("reserved" <= "stock"),
  ADD CONSTRAINT "ck_skus_restock_cycle_non_negative" CHECK ("restock_cycle" >= 0);

ALTER TABLE "cart_items"
  ADD CONSTRAINT "ck_cart_items_quantity_positive" CHECK ("quantity" > 0);

-- orders: the discount's arithmetic, and the two delivery columns that
-- record a single fact and must move together.
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

-- payment_links: this is the price that's honored when a payment comes in
-- for a link that's already deactivated, because the webhook never rejects.
ALTER TABLE "payment_links"
  ADD CONSTRAINT "ck_payment_links_unit_price_positive"
    CHECK ("unit_price_at_creation" > 0);

-- promo_codes: usage_limit is constant, so what's available is the
-- subtraction of the other two. The third CHECK is what prevents handing out
-- more uses than the account has.
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

-- stock_notifications: sent_at and status record a single fact, so the
-- contradictory row isn't representable.
ALTER TABLE "stock_notifications"
  ADD CONSTRAINT "ck_stock_notifications_sent_pair"
    CHECK (("sent_at" IS NOT NULL) = ("status" = 'SENT'));
