# MNMWhole — Wholesale & Liquidation

Static storefront for https://mnmwhole.com. GitHub Pages publishes main / (root).

- `/` — public storefront and catalog
- `/admin/` — browser-only draft editor; not authenticated and does not publish listings
- `products.json` — public inventory listings; starts empty

**Important:** GitHub Pages cannot run Clerk's server-side verification or owner inventory backend. The full-stack Clerk version lives on a separate migration branch of chaimh9498/mandm, and requires backend hosting, Clerk credentials, and persistent storage. Do not store secrets here. Stripe disabled.
