-- Buyers can pay in a currency other than the base currency. Orders and wallets stay in the base currency;
-- a payment remembers what was actually charged (amount_minor / currency) and the base value it covers.
ALTER TABLE payments ADD COLUMN base_amount_minor bigint;
ALTER TABLE payments ADD COLUMN fx_rate numeric(18, 8) NOT NULL DEFAULT 1;  -- base units per 1 unit of the charged currency
UPDATE payments SET base_amount_minor = amount_minor WHERE base_amount_minor IS NULL;
ALTER TABLE payments ALTER COLUMN base_amount_minor SET NOT NULL;
