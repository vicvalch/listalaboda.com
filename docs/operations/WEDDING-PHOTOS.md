# Wedding-site photos: deployment, operation and reversal (UX-01B, ADR-022)

Status: **code ready behind `WEDDING_SITE_PHOTOS` (off)**. Nothing here has been done in production. Every production
step below is a separate, explicitly approved action by the owner.

Production snapshot (read-only audit, 2026-10-22, UX-01B4): migration history 41/41 (last `20261027120000`; the photo
migration is NOT applied), no Storage buckets, 0 objects, 0 `storage.objects` policies, database 14.6 MB, 0 published
sites; Vercel Production serves `bf77128` (governance only, no photo code). The photo code reached `main` only through
the UX-01B4 QA PR (PR #51 had been merged into the governance branch, not `main`).

## 1. What exists

- Migration `supabase/migrations/20261028120000_lb_wedding_site_photos.sql`:
  - tables `wedding_photos`, `wedding_site_photo_blocks`, `wedding_photo_origin_usage`, `private.wedding_photo_upload_days`;
  - RPCs `create_wedding_photo`, `complete_wedding_photo`, `set_wedding_cover_photo`, `move_wedding_site_photo_block`,
    `move_wedding_photo` and `claim_published_wedding_photo` (the last one service_role only);
  - `get_published_wedding_site` recreated with `site_photos`;
  - the **private bucket `wedding-photos`** (1 MB objects, `image/webp` only) and its storage policies.
- The bucket is created by the migration: applying it IS the "storage resource" step. Nothing else needs to be provisioned
  (no new vendor, secret or plan).
- Server flag `WEDDING_SITE_PHOTOS`: exactly `on` enables photos; anything else (default: unset) disables the editor,
  the uploads, `site_photos` on public pages and every photo route (404).
- `SUPABASE_SERVICE_ROLE_KEY` is already set in production; the photo origin (`src/lib/wedding-site/photo-origin.ts`)
  reuses it, read-only.
- Dependency `sharp` 0.35.5 (pinned; already Next's optional dependency, prebuilt for Vercel's linux-x64).

## 2. Production sequence (each step needs explicit approval)

1. **Governance merged** (PR A: Constitution amendment, ADR-022 Accepted, ADR-002 §6).
2. **Review the migration**, then apply it to production BEFORE the code (QA-03a lesson). Read-only prechecks:
   - `select id from storage.buckets where id = 'wedding-photos'` → no row;
   - `select count(*) from storage.objects` (to know the starting storage use);
   - migration history aligned (`supabase migration list --linked`): only `20261028120000` pending.
   Then `db push` from a clean LF export of `origin/main`'s `supabase/` (scratch `--workdir`, as for QA-03a).
   Post-checks: the 4 tables with RLS on, the bucket private with 1 MB/`image/webp`, 3 storage policies on
   `storage.objects` for `wedding-photos`, `claim_published_wedding_photo` EXECUTE for service_role only,
   `get_published_wedding_site` still returns rows for published sites (now with `site_photos = []`).
3. **Deploy the code with the flag OFF** (default). Check: `/boda/<slug>` unchanged; `/boda/<slug>/fotos/<uuid>/640` → 404;
   `/app/weddings/<id>/site` shows no "Fotos" card.
4. **Non-production smoke** (preview deployment or local against a non-production project, flag on): upload, cover,
   preview, publish, public photo, unpublish → 404, delete. Generated test images only.
5. **Privacy/Terms readiness**: the legal texts in `docs/product/UX-01B-PHOTOGRAPHY-PLAN.md` §6, reviewed and published.
6. **Controlled activation** (separate owner approval): set `WEDDING_SITE_PHOTOS=on` in Vercel Production and redeploy;
   smoke with an owner-approved QA wedding and generated images; check Supabase storage/egress and Vercel transfer.

## 3. Turning photos off safely

1. Set `WEDDING_SITE_PHOTOS` to anything but `on` (or remove it) and redeploy: editor hidden, uploads refused, public
   pages drop photos, photo routes 404 on every **uncached** request.
2. Purge the CDN copies already cached (up to 30 days otherwise): Vercel → Project → CDN → Caches → Purge →
   **Delete**, cache tag `*` (whole project) or each `lb-photo-<id>`. Browsers may keep a copy for up to 10 minutes.
3. Data stays (rows and objects): turning the flag back on restores everything as it was.

## 4. Removing the feature entirely (only if decided)

1. Steps of §3.
2. Delete every object of the bucket through the Storage API (dashboard → Storage → `wedding-photos` → select all →
   delete, or the reconcile script below with all names). SQL deletes of `storage.objects` are refused by Supabase.
3. A reviewed forward migration that drops the tables, functions and the bucket, and recreates
   `get_published_wedding_site` without `site_photos`. Applied migrations are never edited.

## 5. Breakers and quotas (ADR-022 §6)

| Limit | Value | Where to see it |
|---|---|---|
| Photos per wedding (pending included) | 20 | `select wedding_id, count(*) from public.wedding_photos group by 1 order by 2 desc` |
| Uploads per wedding per UTC day | 60 | `private.wedding_photo_upload_days` |
| Pending uploads at once | 3 | `state = 'pending'` rows |
| Stored per wedding | 40 MB | `sum(bytes)` per wedding |
| **Stored in the bucket** | **800 MB** (of 1 GB free) | `select sum((metadata->>'size')::bigint) from storage.objects where bucket_id = 'wedding-photos'` |
| **Origin downloads per month** | **3 GB** (of 5 GB shared egress) | `select * from public.wedding_photo_origin_usage order by month desc` |

When a breaker trips, uploads say "Las fotos están en pausa por mantenimiento" or uncached photos 404, and the rest of
the site works. Raise a breaker only together with a plan upgrade (Supabase Pro), through a reviewed migration that
changes `private.wedding_photo_limit`.

## 6. Reconcile orphan objects (run after any manual account or wedding deletion)

Rows cascade with the wedding; their objects don't (Supabase forbids SQL deletes of `storage.objects`). An orphan is
never served (the origin claim needs a row), but it uses storage.

List them (read-only):

```sql
select o.name, (o.metadata->>'size')::bigint as bytes, o.created_at
from storage.objects o
where o.bucket_id = 'wedding-photos'
  and not exists (
    select 1 from public.wedding_photos p where p.id::text = split_part(o.name, '/', 1)
  )
order by o.created_at;
```

Delete exactly the listed names through the Storage API, e.g. in the dashboard (Storage → `wedding-photos`) or with
the Supabase CLI from the operator's machine (it asks for confirmation; `--yes` skips the prompt, so use it only after
checking the list):

```sh
npx supabase storage rm --linked --experimental ss:///wedding-photos/<photo id>/1600.webp ss:///wedding-photos/<photo id>/640.webp
```

Never run this against names that still have a row. Stale `pending` uploads (older than 15 minutes) are cleaned by the
next upload of the same wedding; a wedding that never uploads again keeps at most 3 pending rows and their objects
(≤ 6 MB), which this query does not list (they still have rows) and which are never public.

## 7. Known residual risks

- Member previews and editor thumbnails (`…/site/photos/<id>/<rendition>`, `private, no-store`) download from Storage
  on every view and are NOT counted by the 3 GB origin meter. Only members of the wedding can trigger them (≤ 20 photos
  × ~0.4 MB per full page view), so the exposure is bounded by membership, not by a quota. Watch Supabase egress after
  activation; if needed, a short private browser cache (`private, max-age=300`) is the first lever.
- CDN purge by tag (`revalidateTag(tag, { expire: 0 })` → Vercel delete-by-tag) can only be verified on a Vercel
  deployment (§2 step 4 checks it); locally there is no CDN.
- Vercel Hobby is "personal, non-commercial" per Vercel's terms; this predates photos and applies to the paid product.

## 8. Privacy limits to remember

- Published photos are public by address (`noindex`), not secret: anyone with the link can view and save them.
- Unpublishing, hiding, removing or deleting purges the CDN by tag; browsers may keep a copy for up to 10 minutes;
  copies people saved can't be recalled. The editor says so.
- Stored renditions contain no EXIF/GPS/XMP/ICC data; no original or file name is kept.
