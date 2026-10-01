# ADR-003 — Donor Extraction Policy

Status: Accepted (LB-01) · Date: 2026-09-30
Related: [Product Constitution](../product/PRODUCT-CONSTITUTION.md), [ADR-001](ADR-001-product-domain-and-tenancy.md), [ADR-002](ADR-002-auth-and-security-boundaries.md)

## Context

Two existing repositories are useful references for listalaboda.com:

- **Wedding-Fran-Marilu (WFM)** — a single couple's production wedding site
  (Next.js, Supabase, Resend, Vitest, Playwright). It is the domain donor for
  guests, guest invitations, RSVP, reminders, seating and wedding-website UX. It
  contains real couple content, photos (`assets-source/`), guest-facing copy,
  and patterns that are insecure for a multi-wedding product (shared admin
  password, service-role persistence, plaintext tokens, hand-run SQL).
- **PMFreak** (`Republika-Network/pmfreak`) — proprietary software. Its
  `COPYRIGHT` file states "All rights reserved" and that no permission is granted
  to use, copy, modify or create derivative works from its proprietary portions
  without written authorization from OnChainFest LLC. It is an architecture and
  operations donor only, and is entangled with AOC/Frontera governance.

Without an explicit policy, convenience copying would import PII, licensing
exposure, insecure patterns and PM complexity.

## Decision

Donor repositories are **read-only references**. The default for all donor
material is **study, then retype and redesign** — never wholesale copy.

### Wedding-Fran-Marilu

**WHAT MAY BE REUSED (as ideas/knowledge, written fresh)**
- Domain rules learned in production: party-size limits, attending vs not
  attending, per-guest dietary/food preferences, one response per guest invitation
  with later updates, reminder cadence, seating summaries.
- UX flows that proved themselves: RSVP form structure, guest-card patterns,
  admin dashboard summaries, seating-chart interactions, print views.
- Bug lessons documented in its SQL comments and tests (e.g. RSVP double-submit
  must update, not duplicate).
- Test strategy shape (unit / integration / smoke / a11y / visual projects).

**WHAT MAY ONLY BE REIMPLEMENTED**
- RSVP, guest-invitation, reminder and seating logic → redesigned for
  GuestInvitation → Guest → RSVP with `wedding_id` isolation (ADR-001).
- Email templates → rewritten, parameterized per wedding, Spanish copy authored anew.
- Website sections (hero, details, FAQ, travel, hotels…) → generic, data-driven
  components fed by published content, not hardcoded markup.

**WHAT IS FORBIDDEN**
- Any couple-specific content: names, dates, venues, stories, copy, FAQs.
- Photos and assets (`assets-source/`, `public/invitation-*`, etc.).
- Guest data, test fixtures containing real people, database dumps/exports.
- Hardcoded branding, colors or illustrations specific to that wedding.
- Shared-password admin auth (`lib/adminAuth.ts` pattern).
- Service-role persistence for guest flows.
- Plaintext `invite_token` storage, token-text joins, tokens in query strings.
- Flattened `guest_details` jsonb as the guest model.
- Hand-run SQL files as the migration mechanism.

**LICENSING / PII / SECURITY CONCERNS**
- Owned by the same author, so licensing risk is low; **PII and privacy risk is
  high**. Nothing that identifies the couple or their guests may enter this repository.
- Its security model was scoped to one trusted couple; every borrowed flow must
  be re-threat-modeled for many untrusted tenants.

### PMFreak

**WHAT MAY BE REUSED (as ideas/knowledge, written fresh)**
- General engineering patterns that are common industry practice: Supabase SSR
  session handling approach, RLS helper-function style, timestamped CLI
  migrations, generated DB types, CI verification gates, Playwright project layout.
- Operational lessons: migration parity checks, environment separation,
  schema-contract verification.

**WHAT MAY ONLY BE REIMPLEMENTED**
- Any concept above, implemented independently from public documentation and
  first principles, sized for a wedding checklist — not adapted from PMFreak source.

**WHAT IS FORBIDDEN**
- Verbatim or lightly edited PMFreak source code, SQL, configuration, prompts,
  docs or assets.
- PMFreak, Republika, AOC or Frontera branding or naming.
- Any dependency on AOC, Frontera, or PMFreak packages, services or vendor directories.
- Governance machinery: governed actions, approval workflows, policy engines,
  decision-integrity layers, RAID, CPM, baselines, forecasts, AI execution authority.
- PM domain vocabulary as product concepts (project, program, portfolio, PMO,
  stakeholder, workstream).

**LICENSING / PII / SECURITY CONCERNS**
- **Licensing is the primary risk.** PMFreak is proprietary (OnChainFest LLC,
  all rights reserved). Even if the same people are involved, copying creates
  derivative-work and ownership ambiguity for listalaboda.com. Any intended
  reuse of actual PMFreak code requires a written decision from the rights
  holder first, recorded in a new ADR.
- Its customer/tenant data, secrets, `.env` files, backups (`pmfreak-prod-backups`)
  and artifacts must never be read into or referenced from this repository.

### Process rules

1. A donor-inspired change must say so in its PR/commit description
   (e.g. "RSVP flow informed by WFM; reimplemented").
2. Reviewers reject diffs that contain donor identifiers, couple names, PMFreak
   naming or recognizably copied blocks.
3. Donor repositories are never modified as part of listalaboda.com work.
4. Third-party open-source libraries used by donors may be adopted directly
   under their own licenses — that is dependency selection, not donor extraction.

## Consequences

**Positive**
- Clean IP provenance for listalaboda.com.
- No PII leakage from a real wedding.
- Forces the multi-wedding redesign the domain needs anyway.

**Negative / accepted costs**
- Slower than copy-paste for flows WFM already solved.
- Some reviewer judgment is needed to tell "pattern" from "copy".

## Rejected Alternatives

| Alternative | Why rejected |
|---|---|
| Fork WFM and generalize it | Carries single-wedding assumptions, PII and insecure auth into the foundation. |
| Copy PMFreak's auth/tenancy layer | Proprietary licensing; drags governance and project-centric tenancy. |
| No donor use at all | Wastes production-proven wedding domain knowledge. |
| Case-by-case copying without a policy | Inconsistent; guarantees eventual PII or IP leakage. |
