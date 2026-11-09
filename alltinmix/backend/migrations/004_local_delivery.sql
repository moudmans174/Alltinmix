-- Local delivery and payment: cash on delivery, pickup, delivery zones, SMS alerts.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending','awaiting_confirmation','paid','failed','refunded','partially_refunded','cod'));

ALTER TABLE orders ADD COLUMN delivery_method text CHECK (delivery_method IN ('ship','pickup'));
ALTER TABLE orders ADD COLUMN delivery_fee_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN delivery_zone text;
ALTER TABLE orders ADD COLUMN delivery_address jsonb;

-- With cash on delivery the seller holds the cash, so the platform fee is charged to the seller's balance.
ALTER TABLE wallet_entries DROP CONSTRAINT IF EXISTS wallet_entries_kind_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check CHECK (kind IN ('earning','withdrawal','adjustment','commission_due'));
CREATE UNIQUE INDEX wallet_one_commission_per_order ON wallet_entries (order_id) WHERE kind = 'commission_due';

CREATE TABLE sms_outbox (
  id               bigserial PRIMARY KEY,
  to_phone         text NOT NULL,
  body             text NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_outbox_due_idx ON sms_outbox (next_attempt_at) WHERE sent_at IS NULL;
