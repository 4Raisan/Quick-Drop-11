# Supabase setup

Quick Drop 11 supports Supabase Postgres for share metadata and a private Storage bucket for images/PDFs. Existing Vercel Blob support remains available for rollback. The live switch requires completing these steps; installing the adapter alone does not connect a project.

1. Create a free Supabase project named Quick Drop 11. Keep its database password private.
2. Run `supabase/schema.sql` in the SQL editor. It creates `quickdrop_shares`, a private `quickdrop-files` bucket, a 5 MiB size/type restriction and a server-only storage statistics function.
3. Configure these variables in Vercel, then redeploy:
   - `QUICK_DROP_STORAGE=supabase`
   - `QUICK_DROP_SUPABASE_URL`: project API URL
   - `QUICK_DROP_SUPABASE_SERVICE_KEY`: server-only service-role or compatible secret API key
   - `CRON_SECRET`: retain the existing cleanup secret
   - `QUICK_DROP_STORAGE_ALLOWANCE_BYTES=1000000000` (optional; default is 1 GB)
4. Check text sharing, image/PDF uploading, search, download, stats and expiry on the deployment.

No anonymous database or bucket policies are required. The service key bypasses RLS and must never appear in browser files, screenshots, committed files or public stats. Browser uploads receive a signed URL for a reserved pathname; uploads are immutable. Signed uploads use the provider's validity window; verified downloads get links valid for at most 60 seconds or the remaining share lifetime.

The public feed remains public and deletion remains communal. Private storage prevents unverified bytes from being directly publicly served. It does not make published shares private. Files are checked for size, signature and SHA-256 before publishing.

Supabase Free includes 1 GB file storage. Transfer and database allowances are separate; see https://supabase.com/pricing. Public stats show current storage and configured capacity, not exact monthly billing balances. Expired objects are physically deleted during cleanup; old orphan uploads are also removed.

Local development remains isolated even with the Supabase variables set. Remote local testing requires both `QUICK_DROP_STORAGE=supabase` and `QUICK_DROP_REMOTE_LOCAL=1`; do not enable casually. The app does not automatically load `.env.local`.

Existing Blob data is preserved, not automatically imported. A suspended Blob store may be unreadable. Switching back to Blob reselects the original records, but will not resolve the provider's suspension. Pending browser uploads reuse their request IDs and can retry against the selected storage after the switch.
