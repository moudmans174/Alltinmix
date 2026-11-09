-- Buyer features: wishlist, make-an-offer, order timeline, photo reviews.
CREATE TABLE wishlist (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id  uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, listing_id)
);

ALTER TABLE reviews ADD COLUMN images jsonb NOT NULL DEFAULT '[]';

-- Every status change on an order is recorded automatically, so the timeline can never miss a step.
CREATE TABLE order_events (
  id          bigserial PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, id);
CREATE FUNCTION log_order_status() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO order_events (order_id, status) VALUES (NEW.id, NEW.status);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER orders_status_log AFTER INSERT OR UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION log_order_status();

CREATE TABLE offers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id     uuid NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qty            integer NOT NULL DEFAULT 1 CHECK (qty > 0),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),      -- the buyer's offer, per unit
  counter_minor  bigint CHECK (counter_minor > 0),              -- the seller's counter-offer, per unit
  agreed_minor   bigint CHECK (agreed_minor > 0),               -- the price both sides accepted, per unit
  message        text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','countered','accepted','declined','withdrawn','expired','used')),
  expires_at     timestamptz NOT NULL,
  order_id       uuid REFERENCES orders(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX offers_one_open ON offers (buyer_id, listing_id) WHERE status IN ('pending','countered','accepted');
CREATE INDEX offers_seller_idx ON offers (seller_id, created_at DESC);
CREATE INDEX offers_buyer_idx ON offers (buyer_id, created_at DESC);
