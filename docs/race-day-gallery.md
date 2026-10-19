# Wraptor Races attendee gallery

The Shopify section provides the public gallery and attendee Share Studio. The Races Hub is a viewer only. Only a successful registration lookup unlocks the studio UI. Registration is a convenience match, not identity verification.

## Hosting and storage
- Vercel project: wraptorcloud, production branch claude/wraptor-vault-foundation-os1pj6.
- Backend: /api/race-day/{health,gallery,uploads,submissions}.
- Shopify app proxy: /apps/wr27-day → https://wraptorcloud.vercel.app/api/race-day.
- Shopify Files stores photos/videos. Metaobject type wr27_day_submission stores caption, racer ID and media reference.
- Existing Postgres stores short-lived upload tickets and rate limits in wr27_gallery_uploads. Apply only migrations/0010_race_day_gallery.sql with node scripts/race-day-migrate.cjs (already applied on 19 Oct 2026).
- Never expose Shopify credentials in the theme or NEXT_PUBLIC environment variables.

## Shopify connection
Create an app owned by the Wraptor organization. App URL: https://wraptorcloud.vercel.app/api/race-day/health. Embedded app off. App proxy destination as above, prefix apps, subpath wr27-day.
Required permissions: read_files,write_files,read_metaobjects,write_metaobjects,read_metaobject_definitions,write_metaobject_definitions,write_app_proxy.
Install on 459fcb-78.myshopify.com. Store SHOPIFY_CLIENT_ID and SHOPIFY_API_SECRET as server-only sensitive Vercel environment variables. Optional SHOPIFY_SHOP defaults to the exact Wraptor store. The backend refreshes the 24-hour client-credentials token itself.
Create the six-field publishable metaobject definition using the companion setup script after credentials are connected.
Then set the Shopify gallery section upload_endpoint to /apps/wr27-day. Do not enable it until the signed gallery request and real photo/video publish/hide checks pass.

## Managing public posts
Shopify → Content → Metaobjects → WR27 attendee moments. Attendee posts publish ACTIVE immediately, per the owner's decision. Change a post to Draft to hide it from the public feed; restore Active to show it. Shopify video processing can delay appearance until READY. Files remain in Shopify Files if a post is hidden. Official photos remain editor-managed blocks.

## Limits and validation
JPEG/PNG/WebP up to 20 MB; MP4/MOV/WebM up to 100 MB. Client editor limits video to 90 seconds. 12 preparations per client per hour and 500 per day globally. HMAC-verified Shopify proxy, signed expiring tickets, an atomic submission claim, idempotent metaobject upsert, captions inserted as text, Shopify CDN media allowlist. Only the final racer ID is sent; full registrations stay in the browser.

## Checks
Production Next build and TypeScript pass. Signature/ticket/upload validation tests pass. Races Hub checkpoint/reaction/improvement tests live in the Shopify workspace. No real public upload is considered enabled until end-to-end storage and removal tests pass.
