# Portal operations release — 2026-10-29

## Publication sequence

1. User created Neon backup branch `pre-portal-20261029` from `main`, including
   current data/schema, before the production schema update.
2. Published compatibility commit `3ef457eba9d5f557f152af2f22a2d88edb08a6ea`.
   User confirmed `/health` reported `release: schema-bridge` at that revision.
   This uses targetless `ON CONFLICT DO NOTHING` for legacy recording creation,
   allowing that API to keep operating after the old per-step index is removed.
3. Publish the integrated `release/portal-operations` branch, which contains the
   published video recovery, all portal improvements and the bridge ancestry.
   `npm start` runs the transactional migration runner before bootstrap/API.
   Render uses `npm install`, `npm start`, Auto-Deploy On Commit, as confirmed by
   the user. No new production environment variable is required for this update.
4. Confirm `/health` reports `release: portal-operations` with the new revision;
   then reload the merchant portal once and verify the new Orders workflows.

The startup migration runner adopts the old schema and records 001–018 exactly
once. New instances serialize migration attempts with a transaction advisory
lock. Schema errors roll back the transaction and prevent the new API from
starting. Logs report migration/code without connection strings or failing row
contents. Existing credentials, administrator password, JWT key, public URL and
single-camera media environment must be preserved.

## Compatibility and validation

`test/deployment-upgrade.integration.test.js` constructs schema 13, creates an
order/capture with the bridge, starts the new API through `src/start.js`, checks
all 18 migration records, verifies existing process history, continues writes
through the still-running bridge, creates several visits with the new API and
reruns migrations without recreating the removed unique-per-step constraint.
Only a disposable local schema is used.

Final verification includes 39 portal/database/browser tests, 8 real HLS tests
with 60 seconds of HLS.js playback and source restart, and 2 Windows-agent
portable media scenarios on Linux, plus PowerShell core/network checks. Actual
Windows GUI/WLAN, boot-before-login and a signed installer remain unvalidated.
The pilot publisher supervisor separately demonstrated recovery on the user's
Windows PC and customer page without F5.

The release also accepts the actual compact 32-hex camera paths produced by
migration 018 as well as canonical UUID paths used by older agent fixtures.
The MediaMTX control credential generator now uses cryptographic hex rather
than Base64, which could contain `/` rejected by MediaMTX 1.21.3.

## Rollback

If a new deployment fails before switching traffic, keep the healthy bridge.
After schema 18 has been applied, the compatible code rollback target is the
bridge commit above. Do not roll back to older recording code with
`ON CONFLICT(order_id,step_index)`, which requires the index removed by 015.
Do not restore the database over post-deployment orders as a routine code
rollback. A data restore is a separate recovery action using the preserved Neon
branch and must account for new data written after its creation.

## What this release does not deploy

The existing pilot remains in `LIVE_CAMERA_ID` mode with `/camera`; do not enable
central multi-camera mode until its media origin and per-device/camera ingest
authorization exist. A temporary Quick Tunnel is not permanent infrastructure.
No signed `.exe`, Windows service, object storage, video upload/download or
billing provider is created by this portal publication. Network maintenance UI
is development agent code and is not automatically installed on the pilot PC.
