# MNMWhole Cloudflare setup — owner-operated

**Status: schema prepared; Cloudflare resources not yet created or bound.** The current live https://mnmwhole.com site is static GitHub Pages. These SQL tables do not automatically make uploads, customer login or checkout work.

## Account ownership
Client owns Cloudflare, Squarespace domain, Stripe, and Clerk; invite developer through separate accounts with appropriate permissions. Never share secret keys in chat or GitHub. Keep the current GitHub Pages storefront live until the replacement Worker has been tested.

## Create D1 in Cloudflare dashboard
1. Open https://dash.cloudflare.com and select the **client's Cloudflare account**.
2. Navigate to **Storage & databases → D1 SQL database** (dashboard wording can vary).
3. Click **Create database**.
4. Name it exactly **mnmwhole-db** and create it.
5. Open the database's **Console**. Run the SQL in `cloudflare/schema.sql` against this new database (or use Wrangler with the same SQL).
6. Verify `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;` returns seven tables.
7. Keep its **Database ID** for Worker configuration; it's not a password.

## Create R2 for uploaded product images
1. Open **R2 object storage** → **Create bucket**.
2. Name it **mnmwhole-images**.
3. Do not enable public bucket listing; image delivery should use carefully scoped Worker routes.
4. Bind this bucket to your future Worker with binding name `IMAGES`.

## Bind D1 to Worker
1. Under **Workers & Pages**, create a Worker after the app has been adapted to Workers.
2. Select its **Bindings** tab → **Add binding** → **D1 database**.
3. Set variable name `DB` and select `mnmwhole-db`.
4. Also add R2 binding `IMAGES` to `mnmwhole-images`.
5. Store `CLERK_SECRET_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` as **Worker secrets** when those features are ready. Set owner access based on verified Clerk user identity and server-side authorization. Never put these secrets in web client code.

## Deployment architecture
- GitHub Pages: currently serves static MNMWhole storefront only.
- Cloudflare Workers + D1 + R2: proposed for secure APIs, inventory updates, and durable file uploads.
- Clerk: user sign-in and owner authentication; credentials remain managed by Clerk.
- Stripe: client-owned account; keep disabled until an authenticated checkout, webhook signature verification, idempotency and test purchase are implemented.
- Only switch mnmwhole.com to Cloudflare Workers after the replacement is tested. Don't prematurely change the live DNS records.

## Important
The existing full-stack Express app is in the `mnmwhole-production` branch of `chaimh9498/mandm`. It uses filesystem storage and cannot use D1/R2 without a backend rewrite. This new schema prepares that migration; it does **not** constitute a completed deployment.
