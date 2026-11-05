-- ALLTINMIX marketplace schema (PostgreSQL 13+). Money is stored as integer minor units (cents), never floats.

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  email              text NOT NULL,
  password_hash      text NOT NULL,
  role               text NOT NULL CHECK (role IN ('buyer','seller','admin')),
  tag                text NOT NULL DEFAULT '',
  phone              text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  email_verified_at  timestamptz,
  token_version      integer NOT NULL DEFAULT 0,
  payout_method      text,
  payout_details     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('verify_email','reset_password')),
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_hash_idx ON auth_tokens (token_hash);

-- type is validated against config/marketplace.config.js (not a DB CHECK) so new verticals need no migration.
CREATE TABLE listings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            text NOT NULL,
  category        text NOT NULL,
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  price_minor     bigint NOT NULL CHECK (price_minor > 0),
  currency        text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','sold','hidden','deleted')),
  location        text NOT NULL DEFAULT '',
  attributes      jsonb NOT NULL DEFAULT '{}',
  images          jsonb NOT NULL DEFAULT '[]',
  delivery_days   integer,
  fulfillment     text CHECK (fulfillment IN ('physical','digital')),
  stock           integer CHECK (stock >= 0),
  shipping_days   integer,
  delivery_url    text,
  rating_avg      numeric(3,2) NOT NULL DEFAULT 0,
  rating_count    integer NOT NULL DEFAULT 0,
  sold_count      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX listings_browse_idx ON listings (status, type, created_at DESC);
CREATE INDEX listings_seller_idx ON listings (seller_id);

-- One payment can cover several orders (a cart with items from different sellers).
CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id         uuid NOT NULL REFERENCES users(id),
  provider         text NOT NULL,
  method           text NOT NULL,
  provider_ref     text,
  provider_txn_id  text,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  currency         text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','awaiting_confirmation','paid','failed','refunded','partially_refunded')),
  proof            jsonb NOT NULL DEFAULT '{}',
  failure_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_buyer_idx ON payments (buyer_id);
CREATE INDEX payments_status_idx ON payments (status, created_at);
CREATE INDEX payments_ref_idx ON payments (provider, provider_ref);

CREATE TABLE orders (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id              uuid NOT NULL REFERENCES payments(id),
  listing_id              uuid REFERENCES listings(id) ON DELETE SET NULL,
  title                   text NOT NULL,
  type                    text NOT NULL,
  fulfillment             text,
  qty                     integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  unit_price_minor        bigint NOT NULL,
  total_minor             bigint NOT NULL,
  currency                text NOT NULL,
  buyer_id                uuid NOT NULL REFERENCES users(id),
  seller_id               uuid NOT NULL REFERENCES users(id),
  commission_pct          numeric(5,2) NOT NULL,
  commission_minor        bigint NOT NULL,
  seller_earnings_minor   bigint NOT NULL,
  status                  text NOT NULL DEFAULT 'awaiting_payment'
                          CHECK (status IN ('awaiting_payment','pending_acceptance','in_progress','delivered','completed','disputed','refunded','cancelled')),
  download_url            text,
  dispute_reason          text,
  refund_ref              text,
  refund_manual           boolean NOT NULL DEFAULT false,
  refund_settled_at       timestamptz,
  delivered_at            timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC);
CREATE INDEX orders_seller_idx ON orders (seller_id, created_at DESC);
CREATE INDEX orders_payment_idx ON orders (payment_id);
CREATE INDEX orders_status_idx ON orders (status);

-- Seller balance is the SUM of this ledger. The partial unique index makes double-crediting an order impossible.
CREATE TABLE wallet_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  kind          text NOT NULL CHECK (kind IN ('earning','withdrawal','adjustment')),
  amount_minor  bigint NOT NULL,
  order_id      uuid REFERENCES orders(id),
  payout_id     uuid,
  note          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX wallet_one_earning_per_order ON wallet_entries (order_id) WHERE kind = 'earning';
CREATE INDEX wallet_user_idx ON wallet_entries (user_id);

CREATE TABLE payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  status        text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','paid','rejected')),
  method        text NOT NULL,
  details       text NOT NULL,
  reference     text,
  admin_note    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payouts_status_idx ON payouts (status, created_at);

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id       uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (listing_id, buyer_id)
);
CREATE INDEX conversations_buyer_idx ON conversations (buyer_id, last_message_at DESC);
CREATE INDEX conversations_seller_idx ON conversations (seller_id, last_message_at DESC);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body             text NOT NULL,
  read_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages (conversation_id, created_at);

CREATE TABLE reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  listing_id   uuid REFERENCES listings(id) ON DELETE CASCADE,
  reviewer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating       integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_listing_idx ON reviews (listing_id, created_at DESC);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  link        text,
  is_read     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Emails are queued here and sent by a background worker with retries, so a slow or failing
-- mail server never slows down or breaks a customer's request.
CREATE TABLE email_outbox (
  id               bigserial PRIMARY KEY,
  to_email         text NOT NULL,
  subject          text NOT NULL,
  html             text NOT NULL,
  text             text NOT NULL DEFAULT '',
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE sent_at IS NULL;

CREATE TABLE settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);

CREATE TABLE admin_audit (
  id          bigserial PRIMARY KEY,
  admin_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target      text,
  details     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
