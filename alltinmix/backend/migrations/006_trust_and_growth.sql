-- Trust (verified sellers) and seller growth tools (coupons, boosts, analytics).
ALTER TABLE users ADD COLUMN verification_status text NOT NULL DEFAULT 'none' CHECK (verification_status IN ('none','pending','approved','rejected'));
ALTER TABLE users ADD COLUMN verified_seller_at timestamptz;
ALTER TABLE users ADD COLUMN verification_doc text;      -- file name in the private folder, never served publicly
ALTER TABLE users ADD COLUMN verification_note text;

ALTER TABLE listings ADD COLUMN views integer NOT NULL DEFAULT 0;
ALTER TABLE listings ADD COLUMN promoted_until timestamptz;
CREATE INDEX listings_promoted_idx ON listings (promoted_until) WHERE promoted_until IS NOT NULL;

CREATE TABLE coupons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code             text NOT NULL,
  percent_off      integer CHECK (percent_off BETWEEN 1 AND 90),
  amount_off_minor bigint CHECK (amount_off_minor > 0),
  min_order_minor  bigint NOT NULL DEFAULT 0,
  max_uses         integer CHECK (max_uses > 0),
  used_count       integer NOT NULL DEFAULT 0,
  expires_at       timestamptz,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((percent_off IS NOT NULL) <> (amount_off_minor IS NOT NULL))
);
CREATE UNIQUE INDEX coupons_code_idx ON coupons (upper(code));

CREATE TABLE coupon_uses (
  coupon_id  uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id   uuid REFERENCES orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (coupon_id, user_id)
);

ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_kind_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check CHECK (kind IN ('earning','withdrawal','adjustment','commission_due','boost'));

ALTER TABLE orders ADD COLUMN discount_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN coupon_code text;
