# Stripe Dashboard settings that the repository can't set (Batch 1)

Operator checklist. Architecture: [ADR-021 §16](../architecture/ADR-021-stripe-billing-entitlements.md).

The app only sends the configured Price id, the mode, metadata, `allow_promotion_codes` and a fixed
`custom_text.submit.message` to Stripe Checkout. Everything below lives in the Stripe Dashboard: change it there,
**live mode and test mode alike**, and record what you changed. None of it needs a deploy.

Do the legal-page items only after `/terminos` and `/privacidad` are live in production.

## 1. Public business identity (Settings → Business → Public details)

- [ ] **Public business name**: `ListaLaBoda` (what Checkout shows as "Pagar a …" and on receipts).
- [ ] **Support email**: `soporte@listalaboda.com` (it must receive mail first: Resend only sends; set up an inbox or
      forwarding with the domain's MX records).
- [ ] **Support website / URL**: `https://listalaboda.com`.
- [ ] **Privacy policy URL**: `https://listalaboda.com/privacidad`.
- [ ] **Terms of service URL**: `https://listalaboda.com/terminos`.

The legal entity behind the Stripe account can stay OnChainFest LLC: the Terms and the privacy policy name it as the
operator ("listalaboda.com es operado por OnChainFest LLC.").

## 2. Branding (Settings → Branding)

- [ ] Icon / logo and brand color for Checkout, the Customer Portal and receipts.

## 3. Statement descriptor (Settings → Business → Public details, or Payments settings)

- [ ] **Statement descriptor**: recognizable on a card statement, e.g. `LISTALABODA` (5–22 characters, Latin letters).
- [ ] **Shortened descriptor** (if shown): e.g. `LISTALABODA`.

## 4. Products (Product catalog)

Prices and Price ids stay exactly as they are (`STRIPE_PLANNER_MONTHLY_PRICE_ID`, `STRIPE_COUPLE_ONE_TIME_PRICE_ID`).

- [ ] **Couple product**: name e.g. `ListaLaBoda · Acceso para tu boda`; description about the couple product, e.g.
      "Pago único para organizar tu boda: pendientes, invitados, mesas, presupuesto, cronograma y el sitio web de tu boda."
      It must never say "wedding planners".
- [ ] **Planner product**: review that the name and description describe the planner subscription.

## 5. Presentment currency (Settings → Payments → Adaptive Pricing)

The site, the FAQ and Facturación promise **$99 USD per month** and **$149 USD one-time**. With Adaptive Pricing on, a
Costa Rican browser sees Checkout in colones first (₡ amounts that vary with the exchange rate).

- [ ] Turn **Adaptive Pricing off** (or otherwise make USD the default presentment currency), then check from a Costa
      Rica locale/IP that Checkout opens at **$99.00 USD por mes** and **$149.00 USD**.

## 6. Customer Portal (Settings → Billing → Customer portal)

The Terms say cancellation stops the next renewal and access stays until the end of the paid period.

- [ ] **Cancel subscriptions**: enabled, mode **at the end of the billing period** (not immediately).
- [ ] **Update payment methods**: enabled.
- [ ] Business information shows the Terms and privacy links (from Public details above).

## 7. Before the couple $0 rerun (not Batch 1)

- [ ] Live promotion code `QA-COUPLE-100`: exists in **live** mode, active, its coupon applies to the couple product,
      100% off, no "first-time order only", no minimum amount. Then rerun the couple $0 smoke.

## After changing anything

Rerun the Checkout visual checks (stop before paying): planner and couple from `/app/billing`, verifying the business
name, the product line, the USD amount, the promotion-code field and the message above the pay button.
