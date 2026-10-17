# Billing promotions: promo codes and planner trials (BILLING-02)

Operator guide. Architecture: [ADR-021 §15](../architecture/ADR-021-stripe-billing-entitlements.md).

Stripe is the discount authority. The app never takes a coupon, promotion code, percentage or amount from anyone:
every Checkout Session (planner subscription and couple one-time payment) has `allow_promotion_codes: true`, and the
customer types the code on Stripe's hosted page, where Stripe validates and applies it. Creating, changing or ending a
promotion needs **no code change and no deploy**.

Always try a new promotion in Stripe **TEST mode** first (test products/prices, test card `4242 4242 4242 4242`), then
recreate it in live mode.

## How to create a promotion code

1. Open the Stripe Dashboard (test or live mode, as intended).
2. Go to **Product catalog → Coupons** and click **+ New** (Create a coupon).
3. Create the coupon:
   - **Type**: percentage (`25%`, `50%`, `100%`) or fixed amount (`$20`, in **USD**: both plans are priced in USD).
   - **Duration**: `Once`, `Multiple months` (repeating) or `Forever`. For the planner subscription this decides how
     many monthly invoices get the discount. For the couple one-time payment any duration discounts the single payment.
   - **Apply to specific products** (recommended): pick the planner product, the couple product, or both, so a code
     made for one audience can't be used on the other.
   - **Redemption limits** (optional): a last redemption date and/or a total number of redemptions.
4. In the same dialog (or later, from the coupon's page), add a **promotion code** on top of the coupon
   ("Use customer-facing promotion codes"):
   - **Code**: the string people will type, e.g. `NOVIOS2027`, `PLANNERS50`. Case-insensitive; must be unique among
     active codes.
   - Optional restrictions:
     - **Eligible for first-time order only** (customers with no previous payment or trial in Stripe);
     - **Limit to a specific customer** (a one-off code for one account);
     - **Expiration date**;
     - **Limit the number of times this code can be redeemed**;
     - **Require minimum order value**.
5. Share the code. The customer opens "Facturación" → "Suscribirme" / "Pagar el acceso", and enters the code in Stripe
   Checkout's promotion-code field. Stripe shows the discounted total before they confirm.
6. To stop a code early: on the coupon's page, archive the promotion code (or delete the coupon; existing discounts
   stay, new redemptions stop).

Nothing else is needed: the webhook records whatever Stripe charged, and access follows the subscription or purchase
state exactly as without a code.

## Which tool for which offer

| Offer | Use | Why |
|---|---|---|
| Couple: discount on the one-time payment (`25%`, `$20`, …) | Promotion code | Stripe discounts the single payment. |
| Couple: free access | Promotion code on a **100% off** coupon | Checkout completes at $0 without any card; the verified webhook still grants `couple_access`. |
| Planner: cheaper months (`50%` for 3 months, …) | Promotion code on a `repeating` (or `forever`) coupon | Discounts the monthly invoices. |
| Planner: "free for X days", then normal billing | **Trial campaign** (below), NOT a 100% off coupon | A trial collects the card now and starts billing automatically when it ends; a 100% coupon would keep a $0 subscription with no clear end. |

## Planner trial campaigns

Approved campaigns are fixed in code (`src/lib/billing/campaigns.ts`): `planner_trial_7` (7 days),
`planner_trial_14` (14 days), `planner_trial_30` (30 days). Adding another length is a code change.

1. **Turn a campaign on**: set `PLANNER_TRIAL_CAMPAIGNS` in Vercel (Production) to the key(s), comma-separated, e.g.
   `planner_trial_14` (not a secret), and redeploy. Unset = no trial is ever applied (the default).
2. **Share the link**: `https://listalaboda.com/app/billing?campaign=planner_trial_14`. Signed-out people log in (or
   sign up) and choose their account type first; the campaign key is kept. The billing page then shows
   "Prueba gratuita de 14 días" and "Después, $99 USD/mes."
3. **Turn it off**: remove the key from `PLANNER_TRIAL_CAMPAIGNS` and redeploy. Existing trials continue in Stripe.

Rules the server enforces (the link can't override them): planners only (couples never get a trial); only an
enabled key; only a planner's FIRST subscription (no repeat trials); the length comes from the key, never from the
URL. Checkout always collects a payment method; when the trial ends Stripe charges $99 USD and access continues;
if that charge fails the subscription goes `past_due` and access stops (no grace period) until the planner fixes the
payment method in "Administrar suscripción".

### Trial + promotion code

A planner may enter a promotion code during a trial Checkout. Stripe attaches the code's coupon when the subscription
starts, which is the START of the trial, so the coupon's duration runs from there:

- `forever`: every paid invoice after the trial is discounted.
- `repeating` for N months: the N-month window starts at the trial start, and only invoices issued inside it are
  discounted, so a longer trial pushes paid invoices out of the window (a 30-day trial uses up one of the months).
- `once`: applies to the first invoice, which for a trial is the $0 trial invoice, so it may be used up with no effect.

So don't hand out `once` planner codes together with a trial link. Use a `repeating` coupon that outlasts the trial,
and check the result in TEST mode before announcing it.

## Never do

- Never put a promotion code, coupon id, discount or trial length in a link, form or email "for the app to apply".
  The app ignores them by design.
- Never advertise a trial or promotion on the marketing pages unless that campaign is intentionally active (the pages
  stay evergreen: price + "¿Tienes un código promocional? Podrás aplicarlo en la página de pago.").
- Never use the success page as proof of payment: access comes only from the verified webhook.
