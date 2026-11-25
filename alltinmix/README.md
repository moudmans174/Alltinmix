# ALLTINMIX: a white-label marketplace

One platform for **products, services, real estate and vehicles**. Escrow-style payments, commission on every sale, seller wallets and withdrawals, messaging, reviews, email and in-app notifications, and an admin panel.

- **Backend:** Node 20 + Express 5 + PostgreSQL (`backend/`)
- **Frontend:** React 18 + Vite (`frontend/`)
- **Payments:** Orange Money, Afrimoney, QMoney, credit/debit card (Stripe or Flutterwave), PayPal

**Phone apps:** Android and iPhone versions are included (Capacitor). See **[MOBILE.md](MOBILE.md)**.

---

## 1. Run it on your computer (Windows + VS Code)

You need **Node 20+** (nodejs.org) and **PostgreSQL 16** (postgresql.org/download, remember the password you set for the `postgres` user). Alternative: Docker Desktop, see section 2.

**Create the database** (open the "SQL Shell (psql)" app that comes with PostgreSQL):

```sql
CREATE DATABASE alltinmix;
```

**Backend** (VS Code terminal 1):

```powershell
cd backend
copy .env.example .env      # then edit .env: put your postgres password in DATABASE_URL
npm install
npm run migrate
node src/cli.js create-admin you@yourmail.com "Your Name" "a-strong-password"   # your first admin
npm run dev
```

**Frontend** (VS Code terminal 2):

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 and sign in with the admin you created (the site starts empty: no demo data). With `PAYMENT_PROVIDERS=mock` the checkout shows a **Test payment** option that moves no money.

> If `'vite' is not recognized`: you are in the wrong folder or `npm install` did not finish. Run it inside `frontend`, delete `node_modules`, run `npm install` again. Avoid folders synced by OneDrive.

Run the backend test-suite (needs a Postgres it can wipe, set `TEST_DATABASE_URL`): `npm test` in `backend/`.

---

## 2. Deploy for a client (Docker, one server)

```bash
cp .env.example .env        # fill it in (see below)
docker compose up -d --build
docker compose exec backend node src/cli.js create-admin you@example.com "Your Name" "a-strong-password"
```

The site is served on `WEB_PORT` (default 8080). Put it behind HTTPS (Caddy, Cloudflare, or your host's load balancer) and set `CLIENT_URL` and `API_URL` to the public `https://` address. Migrations run automatically on start. The site starts empty. Create your admin with the command above, then add categories' first listings through the app.

**Production checklist**

- [ ] `JWT_SECRET` set to 32+ random characters (the app refuses to start otherwise)
- [ ] Strong `POSTGRES_PASSWORD`; back up the `pgdata` volume (`pg_dump`) on a schedule
- [ ] Back up the `uploads` volume (listing photos)
- [ ] SMTP configured (SendGrid, Mailgun, Brevo, Gmail app password, ...) and `EMAIL_FROM` on a domain you own
- [ ] HTTPS in front, `CLIENT_URL`/`API_URL` use `https://`
- [ ] Payment provider webhooks registered (section 4)
- [ ] An admin account created with `create-admin`
- [ ] `SUPPORT_EMAIL`, `EMAIL_FROM`, `CLIENT_URL`, `API_URL` set to your real values (the app refuses to start in production while they are placeholders)
- [ ] Test one full purchase with every enabled method before launch

---

## 3. Customise per client

Each client gets their **own deployment** (own database, own `.env`). Everything client-specific lives in two places, no code changes needed:

| What | Where |
| --- | --- |
| Name, tagline, logo URL, colours, support email, currency, default commission | `.env` (`BRAND_*`, `CURRENCY_*`, `DEFAULT_COMMISSION_PCT`) |
| Which payment methods are on, merchant mobile-money numbers | `.env` |
| Categories, listing fields, what is sold (products / services / property / vehicles), checkout vs. "contact seller" | `backend/config/marketplace.config.js` |
| Commission rate after launch | Admin panel, Overview tab (applies to new orders) |

**Add a new vertical** (rentals, events, jobs, ...): add an entry to `verticals` in `marketplace.config.js` with a `key`, `label`, `categories`, custom `fields`, and `commerce`/`mode`:

- `commerce: 'product' | 'service' | 'classified'`
- `mode: 'checkout'` (cart, payment, escrow) or `'inquiry'` (buyer messages the seller)

Pick icons with `icon` and `categoryIcons` (by lucide icon name). To use an icon that isn't in the list yet, import it in `frontend/src/icons.jsx` and add it to the registry.

No migration is needed; the forms, search and listing pages adapt automatically. Restart the backend after changing it.

---

## 4. Payments: what is automatic and what is not

| Method | How it works | Needs |
| --- | --- | --- |
| **Credit / debit card** | Stripe Checkout or Flutterwave hosted page. Confirmed by webhook and on return. Refunds are automatic. | Provider account + keys. Webhook: `API_URL/api/webhooks/stripe` or `/flutterwave` |
| **PayPal** | PayPal Orders v2: buyer approves, we capture on return. Refunds automatic. | Client ID/secret. Optional webhook `API_URL/api/webhooks/paypal` + `PAYPAL_WEBHOOK_ID`. PayPal must support your currency. |
| **Orange Money / Afrimoney / QMoney** | **Manual confirmation.** Buyer sends money to your number with a reference, enters the transaction ID, an admin checks their wallet and clicks *Confirm* (Admin → Payments to confirm). | Your merchant numbers in `.env` |

Be aware of these limits before you promise a client anything:

- Mobile money is **not automated**. Orange Money has a merchant web-payment API in some countries and that can be added as a provider once you have credentials and docs from Orange; Afrimoney and QMoney have no public API. The manual flow works everywhere today.
- Mobile money **refunds are manual**. They show in Admin → Refunds due; you send the money from your wallet and mark it done.
- **Seller withdrawals are manual.** Sellers request a payout, the balance is deducted at once, an admin sends the money (any method) and records the reference.
- The Stripe, Flutterwave and PayPal integrations follow the providers' documentation and are covered by automated tests using stubbed provider responses. **Run each one in the provider's sandbox with real test keys before going live.** Check that the provider supports your country and currency.

**Money flow:** buyer pays → money held → seller accepts and delivers → buyer confirms (or auto-confirms after `AUTO_COMPLETE_DAYS`) → seller wallet credited minus commission. Disputes are decided by an admin (release or refund). Unpaid checkouts expire and return their stock.

---

**Currencies.** Prices are set and recorded in Leones (`CURRENCY_CODE=SLE`, shown as "Le 1,500"). Buyers can switch the display to US dollars (button in the header) and choose **which currency to pay in** at checkout. Dollars are converted at a rate an admin sets in Admin → Overview → Exchange rates (starting value `FX_RATES=USD:22.5`). The rate is saved with each payment, so later rate changes never affect payments already made.

Each payment method lists the currencies it accepts, which decides what buyers see after picking a currency:

| Method | Default currencies | Change with |
| --- | --- | --- |
| Orange Money, Afrimoney, QMoney | Leones | `MOMO_CURRENCIES` |
| Credit / debit card (Stripe or Flutterwave) | US dollars | `CARD_CURRENCIES` |
| PayPal | US dollars | `PAYPAL_CURRENCIES` |

So a buyer paying in dollars is offered card and PayPal, and a buyer paying in Leones is offered mobile money. Seller earnings, wallets, withdrawals and commission always stay in Leones; refunds go back in the currency the buyer paid. Check with your card provider which currencies your account can charge before going live. To use other currencies, add them to `FX_RATES` (supported: SLE, USD, EUR, GBP).

### Monime setup

Monime gives buyers one secure page for Orange Money, Afrimoney and cards, and confirms payments automatically (no admin checking needed).

1. In your Monime dashboard, copy your **Space ID** (starts with `spc-`) and create an **access token**.
2. In `backend/.env` add: `PAYMENT_PROVIDERS=monime,...`, `MONIME_SPACE_ID=...`, `MONIME_ACCESS_TOKEN=...`.
3. Run `node src/cli.js monime-check` in `backend/`. It tests your keys and prints the webhook address.
4. In Monime, add that webhook address (`https://YOUR-API/api/webhooks/monime`) if your dashboard offers webhooks. It is optional: the server also asks Monime about pending payments every 20 seconds and when the buyer returns to the site.
5. **Before going live**, pay a real **Le 1** order and check that Monime shows Le 1 (not Le 100). If it is wrong, set `MONIME_AMOUNT_UNIT=major` and restart.

Safety: a payment is only marked paid after our server asks Monime's API and gets "completed", so a fake webhook cannot release an order. Monime refunds are done by hand in your Monime dashboard and recorded under Admin > Refunds due.

## 5. Logo

Put the logo file in `frontend/public/` as `logo.png` (or `.svg`, `.webp`) and set `BRAND_LOGO_URL=/logo.png` in `backend/.env`, then restart the backend. It appears in the header, as the browser tab icon, and in emails. It is shown as a round badge next to the name (set `BRAND_SHOW_NAME=false` if the logo already contains the name). If a logo disappears on the dark header, set `BRAND_LOGO_PLATE=true` to put it on a white badge. A wide logo about 400 px wide works best.

## 6. Light and dark theme

A sun/moon button in the header switches between light and dark. The choice is remembered per browser, and the first visit follows the visitor's device setting. In dark mode the header and hero use a neutral dark colour; the client's accent colour (`BRAND_ACCENT_COLOR`) is kept.

## 7. Project layout

```
backend/
  config/marketplace.config.js   brand, verticals, categories, fields
  migrations/                    SQL schema (applied automatically)
  src/routes/                    auth, listings, orders, payments, account, admin, messages
  src/services/orders.js         checkout, escrow, refunds, disputes
  src/payments/                  stripe, flutterwave, paypal, mobile money, mock
  test/api.test.js               end-to-end tests
frontend/
  src/pages/                     Shop, Checkout, Auth, Orders, Messages, Seller, Admin
  src/context.jsx                config/branding, auth, cart, toasts
docker-compose.yml, .env.example
```

CLI (run from `backend/`): `npm run migrate`, `node src/cli.js create-admin <email> <name> <password>`.

## 8. Local delivery, cash on delivery and alerts

- **Delivery or pickup:** for physical items buyers choose delivery (area, address, phone) or pickup. Admin sets delivery areas and fees in Admin → Overview. The fee is charged once per seller and goes to the seller.
- **Cash on delivery** (`COD_ENABLED=true`): only for carts of physical items, in the base currency. The order goes straight to the seller; no money is held. When the order completes, the platform fee is deducted from the seller's balance, which can go negative ("you owe"). Fees are offset by their future earnings, or the admin records a payment (Admin → Overview → sellers who owe). A seller who owes more than `COD_SELLER_DEBT_LIMIT_MINOR` stops receiving COD orders until they settle. COD has no escrow protection for the buyer, so keep `COD_MAX_MINOR` modest.
- **Contact:** buyer and seller see each other's phone on the order with Call and WhatsApp buttons.
- **SMS/WhatsApp alerts:** set `SMS_PROVIDER` (Twilio, or a webhook to any local gateway). Not tested against live providers here; test with your own account first.
- **Low-data mode:** the lightning button in the header hides photos until tapped; on by default if the phone's Data Saver is on.

## 8b. Buyer, trust and seller-growth features

- **Buyers:** wishlist (heart), make an offer / counter-offer (48 h), order timeline, review photos, recently viewed.
- **Trust:** sellers can submit an ID photo under *Seller > Grow*. It is stored in `PRIVATE_DIR` (never public), only admins can open it (*Admin > Seller ID*), and it is deleted when you approve or reject. Approved sellers get a **Verified** badge, a "Verified sellers only" filter, a public store page (`/store/:id`) with sales, rating and reply time, and there is a *Buyer protection* page (`/protection`).
- **Sellers:** coupons (seller-funded, one use per buyer), promoted listings (paid from the seller's wallet; set `BOOST_PRICE_MINOR` above 0 to switch it on, `BOOST_DAYS` for the length), analytics (views, saves, sales, last 14 days) and CSV bulk upload (up to 100 rows).
- Database changes arrive automatically as migrations 004 to 006 when the server starts.

## 9. Safety features for app stores

Users can report listings, people and messages and block other users; admins review reports in Admin → Reports (hide listing, suspend user, dismiss). Users can delete their own account in Account (refused while they have active orders or wallet money). `ALLOW_DIGITAL_GOODS=false` hides digital downloads. Terms and Privacy pages are at `/terms` and `/privacy`; have them reviewed for your country.

## 10. Security notes

Passwords are hashed with bcrypt; sessions are JWTs that are revoked instantly on suspend or password reset; email-verification and reset tokens are stored hashed; inputs are validated; uploads are type- and signature-checked; rate limits protect login, sign-up and messaging; webhook signatures are verified. Before launch, have the deployment reviewed (HTTPS, firewall, backups) and read the payment provider's own compliance requirements.

## Backups and restore

**On a server (Docker):** `docker compose up -d` also starts a `backup` service. It saves the database and the uploaded files (photos, seller ID documents) into the `backups` volume right away and then every `BACKUP_EVERY_HOURS` (24 by default), and deletes copies older than `BACKUP_KEEP_DAYS` (14).

- List backups: `docker compose exec backup ls -lh /backups`
- Run one now: `docker compose exec backup sh /ops/backup.sh`
- Copy one to your computer: `docker compose cp backup:/backups/<file> .`
- **A backup on the same server is lost if the server is lost.** Set `BACKUP_OFFSITE_CMD` in `.env` to copy them elsewhere after each run (for example `rclone copy /backups remote:alltinmix-backups`), or download them regularly.
- Restore the database (replaces current data, asks you to type YES): stop the backend (`docker compose stop backend`), then `docker compose exec backup sh -c 'sh /ops/restore.sh /backups/<db-file>.sql.gz'`, then `docker compose start backend`.
- Restore photos: `tar -xzf uploads-<stamp>.tar.gz -C /data` (and the same for `private-…`) into the uploads volume.
- **Test a restore once before launch**, into an empty test database, so you know it works when you need it.

**On your Windows computer (development):** run this in PowerShell, using your own password and Postgres version folder:
`& "C:\Program Files\PostgreSQL\17\bin\pg_dump.exe" -U postgres -d tally -f C:\dev\alltinmix-backup.sql`
