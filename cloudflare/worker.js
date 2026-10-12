const ALLOWED_ORIGINS = new Set(["https://mnmwhole.com", "https://www.mnmwhole.com"]);
const CLERK_ISSUER = "https://clerk.mnmwhole.com";
let jwksCache = { expiresAt: 0, keys: [] };

function corsHeaders(request) {
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function jsonResponse(data, request, status = 200, extraHeaders = {}) {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  return new Response(JSON.stringify(data), { status, headers });
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

async function getClerkJwks() {
  if (Date.now() < jwksCache.expiresAt && jwksCache.keys.length) return jwksCache.keys;
  const response = await fetch(`${CLERK_ISSUER}/.well-known/jwks.json`);
  if (!response.ok) throw new Error("Unable to load Clerk signing keys");
  const data = await response.json();
  jwksCache = { keys: data.keys || [], expiresAt: Date.now() + 60 * 60 * 1000 };
  return jwksCache.keys;
}

async function authenticate(request) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = decodeJsonPart(parts[0]);
    const claims = decodeJsonPart(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== "RS256" || !header.kid || !claims.sub || claims.exp <= now ||
        (claims.nbf && claims.nbf > now + 30) ||
        String(claims.iss || "").replace(/\/$/, "") !== CLERK_ISSUER ||
        (claims.azp && !ALLOWED_ORIGINS.has(claims.azp))) return null;
    let keys = await getClerkJwks();
    let jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
      jwksCache.expiresAt = 0;
      keys = await getClerkJwks();
      jwk = keys.find((key) => key.kid === header.kid);
    }
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key,
      decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return valid ? claims : null;
  } catch (error) {
    console.warn("Authentication failed", error);
    return null;
  }
}

function adminIds(env) {
  return new Set(String(env.ADMIN_USER_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));
}

function productImageUrl(key) {
  return `/images/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function formatImage(image) {
  return { id: image.id, url: productImageUrl(image.object_key), altText: image.alt_text,
    sortOrder: image.sort_order };
}

function formatProduct(product, images = []) {
  return {
    id: product.id, name: product.name, slug: product.slug, sku: product.sku,
    category: product.category, description: product.description,
    priceCents: product.price_cents, stock: product.stock, active: Boolean(product.active),
    featured: Boolean(product.featured), images: images.map(formatImage),
    createdAt: product.created_at, updatedAt: product.updated_at
  };
}

function cleanSlug(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 100);
}

function productInput(body) {
  const name = String(body.name || "").trim().slice(0, 150);
  const slug = cleanSlug(body.slug || name);
  const sku = String(body.sku || "").trim().slice(0, 70) || null;
  const category = String(body.category || "General merchandise").trim().slice(0, 70);
  const description = String(body.description || "").trim().slice(0, 3000);
  const priceCents = Number(body.priceCents);
  const stock = Number(body.stock);
  if (!name || !slug || !Number.isSafeInteger(priceCents) || priceCents < 0 ||
      !Number.isSafeInteger(stock) || stock < 0) throw new Error("Invalid product data");
  return { name, slug, sku, category, description, priceCents, stock,
    active: body.active === true ? 1 : 0, featured: body.featured === true ? 1 : 0 };
}

async function productImagesByProduct(env, onlyActive = false) {
  const result = await env.DB.prepare(`SELECT i.* FROM product_images i
    INNER JOIN products p ON p.id = i.product_id ${onlyActive ? "WHERE p.active = 1" : ""}
    ORDER BY i.product_id, i.sort_order, i.created_at`).all();
  const map = new Map();
  for (const image of result.results || []) {
    const list = map.get(image.product_id) || [];
    list.push(image);
    map.set(image.product_id, list);
  }
  return map;
}

async function listProducts(env, includeInactive = false) {
  const result = await env.DB.prepare(`SELECT * FROM products
    ${includeInactive ? "" : "WHERE active = 1"}
    ORDER BY featured DESC, created_at DESC LIMIT 500`).all();
  const images = await productImagesByProduct(env, !includeInactive);
  return (result.results || []).map((product) => formatProduct(product, images.get(product.id) || []));
}

async function getProductBySlug(env, slug) {
  const product = await env.DB.prepare("SELECT * FROM products WHERE active = 1 AND slug = ? LIMIT 1")
    .bind(slug).first();
  if (!product) return null;
  const result = await env.DB.prepare("SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order, created_at")
    .bind(product.id).all();
  return formatProduct(product, result.results || []);
}

async function serveImage(request, env, key) {
  if (!key) return jsonResponse({ error: "Image not found" }, request, 404);
  const object = request.method === "HEAD" ? await env.IMAGES.head(key) : await env.IMAGES.get(key);
  if (!object) return jsonResponse({ error: "Image not found" }, request, 404);
  const headers = corsHeaders(request);
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function getCart(env, userId) {
  const result = await env.DB.prepare(`SELECT c.product_id, c.quantity, p.name, p.slug,
    p.price_cents, p.stock, p.active FROM cart_items c
    INNER JOIN products p ON p.id = c.product_id
    WHERE c.clerk_user_id = ? ORDER BY c.updated_at DESC`).bind(userId).all();
  return (result.results || []).map((row) => ({ productId: row.product_id,
    quantity: Math.min(row.quantity, row.stock), name: row.name, slug: row.slug,
    priceCents: row.price_cents, stock: row.stock, available: Boolean(row.active && row.stock > 0) }));
}async function saveCart
  (request, env, userId) {
  const body = await request.json();
  if (!Array.isArray(body.items) || body.items.length > 100) throw new Error("Invalid cart");
  const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  const displayName = String(body.displayName || "").trim().slice(0, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Invalid email");
  const normalized = body.items.map((item) => ({ productId: String(item.productId || ""),
    quantity: Number(item.quantity) }));
  if (normalized.some((item) => !item.productId || !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1 || item.quantity > 999)) throw new Error("Invalid cart item");
  const statements = [env.DB.prepare(`UPDATE customers SET email=COALESCE(?,email),
    display_name=COALESCE(?,display_name),updated_at=datetime('now') WHERE clerk_user_id=?`)
    .bind(email || null, displayName || null, userId),
  env.DB.prepare("DELETE FROM cart_items WHERE clerk_user_id = ?").bind(userId)];
  for (const item of normalized) statements.push(env.DB.prepare(`INSERT INTO cart_items
    (clerk_user_id, product_id, quantity, updated_at)
    SELECT ?, id, MIN(?, stock), datetime('now') FROM products
    WHERE id = ? AND active = 1 AND stock > 0`).bind(userId, item.quantity, item.productId));
  await env.DB.batch(statements);
  return getCart(env, userId);
}async function listCustomerCarts(env) {
  const result = await env.DB.prepare(`SELECT u.clerk_user_id,u.email,u.display_name,
    c.product_id,c.quantity,c.updated_at AS cart_updated_at,
    p.name,p.sku,p.price_cents,p.stock,p.active
    FROM cart_items c INNER JOIN customers u ON u.clerk_user_id=c.clerk_user_id
    INNER JOIN products p ON p.id=c.product_id
    ORDER BY c.updated_at DESC LIMIT 1000`).all();
  const carts = new Map();
  for (const row of result.results || []) {
    let cart = carts.get(row.clerk_user_id);
    if (!cart) {
      cart = { userId: row.clerk_user_id, email: row.email || null,
        displayName: row.display_name || null, updatedAt: row.cart_updated_at,
        totalCents: 0, itemCount: 0, items: [] };
      carts.set(row.clerk_user_id, cart);
    }
    const quantity = Number(row.quantity) || 0;
    cart.itemCount += quantity;
    cart.totalCents += quantity * (Number(row.price_cents) || 0);
    if (String(row.cart_updated_at) > String(cart.updatedAt)) cart.updatedAt = row.cart_updated_at;
    cart.items.push({ productId: row.product_id, name: row.name, sku: row.sku,
      quantity, priceCents: row.price_cents, stock: row.stock,
      available: Boolean(row.active && row.stock > 0) });
  }
  return [...carts.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}


async function createProduct(request, env) {
  const input = productInput(await request.json());
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO products
    (id,name,slug,sku,category,description,price_cents,stock,active,featured)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(id, input.name, input.slug, input.sku,
    input.category, input.description, input.priceCents, input.stock, input.active, input.featured).run();
  return env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
}

async function updateProduct(request, env, id) {
  const input = productInput(await request.json());
  const result = await env.DB.prepare(`UPDATE products SET name=?,slug=?,sku=?,category=?,
    description=?,price_cents=?,stock=?,active=?,featured=?,updated_at=datetime('now') WHERE id=?`)
    .bind(input.name, input.slug, input.sku, input.category, input.description,
      input.priceCents, input.stock, input.active, input.featured, id).run();
  return result.meta.changes ? env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first() : null;
}

async function deleteProduct(env, id) {
  const result = await env.DB.prepare("SELECT object_key FROM product_images WHERE product_id = ?").bind(id).all();
  const keys = (result.results || []).map((image) => image.object_key);
  if (keys.length) await env.IMAGES.delete(keys);
  const deletion = await env.DB.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return Boolean(deletion.meta.changes);
}

async function uploadImage(request, env, productId) {
  const product = await env.DB.prepare("SELECT id FROM products WHERE id = ?").bind(productId).first();
  if (!product) return null;
  const form = await request.formData();
  const file = form.get("image");
  if (!(file instanceof File) || !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size < 1 || file.size > 5 * 1024 * 1024) throw new Error("Use a JPG, PNG, or WEBP image under 5 MB");
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
  const id = crypto.randomUUID();
  const objectKey = `products/${productId}/${id}.${extension}`;
  await env.IMAGES.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type } });
  await env.DB.prepare(`INSERT INTO product_images (id,product_id,object_key,alt_text,sort_order)
    VALUES (?,?,?,?,?)`).bind(id, productId, objectKey,
    String(form.get("altText") || "").slice(0, 200), Number(form.get("sortOrder")) || 0).run();
  return env.DB.prepare("SELECT * FROM product_images WHERE id = ?").bind(id).first();
}

async function deleteImage(env, id) {
  const image = await env.DB.prepare("SELECT object_key FROM product_images WHERE id = ?").bind(id).first();
  if (!image) return false;
  await env.IMAGES.delete(image.object_key);
  await env.DB.prepare("DELETE FROM product_images WHERE id = ?").bind(id).run();
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request);
      headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, HEAD, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }
    if (request.method === "GET" && pathname === "/health") {
      try {
        await env.DB.prepare("SELECT 1").first();
        await env.IMAGES.head("__connection_test__");
        return jsonResponse({ ok: true, database: "connected", imageStorage: "connected" }, request);
      } catch (error) {
        console.error(error);
        return jsonResponse({ ok: false, error: "A required storage binding is unavailable" }, request, 500);
      }
    }
    if (request.method === "GET" && pathname === "/api/products") {
      try { return jsonResponse({ products: await listProducts(env) }, request); }
      catch (error) { console.error(error); return jsonResponse({ error: "Unable to load products" }, request, 500); }
    }
    if (request.method === "GET" && pathname.startsWith("/api/products/")) {
      try {
        const product = await getProductBySlug(env, decodeURIComponent(pathname.slice(14)));
        return product ? jsonResponse({ product }, request) : jsonResponse({ error: "Product not found" }, request, 404);
      } catch (error) { console.error(error); return jsonResponse({ error: "Unable to load product" }, request, 500); }
    }
    if ((request.method === "GET" || request.method === "HEAD") && pathname.startsWith("/images/")) {
      try { return await serveImage(request, env, decodeURIComponent(pathname.slice(8))); }
      catch (error) { console.error(error); return jsonResponse({ error: "Unable to load image" }, request, 500); }
    }

    if (pathname.startsWith("/api/cart") || pathname.startsWith("/api/orders") || pathname.startsWith("/api/admin/")) {
      const claims = await authenticate(request);
      if (!claims) return jsonResponse({ error: "Sign in required" }, request, 401);
      await env.DB.prepare(`INSERT INTO customers (clerk_user_id,updated_at)
        VALUES (?,datetime('now')) ON CONFLICT(clerk_user_id)
        DO UPDATE SET updated_at=datetime('now')`).bind(claims.sub).run();
      if (pathname === "/api/cart" && request.method === "GET")
        return jsonResponse({ items: await getCart(env, claims.sub) }, request);
      if (pathname === "/api/cart" && request.method === "PUT") {
        try { return jsonResponse({ items: await saveCart(request, env, claims.sub) }, request); }
        catch (error) { return jsonResponse({ error: error.message || "Invalid cart" }, request, 400); }
      }
      if (pathname === "/api/orders" && request.method === "GET") {
        const result = await env.DB.prepare(`SELECT id,status,subtotal_cents,shipping_cents,tax_cents,
          total_cents,created_at,updated_at FROM orders WHERE clerk_user_id=?
          ORDER BY created_at DESC LIMIT 100`).bind(claims.sub).all();
        return jsonResponse({ orders: result.results || [] }, request);
      }
      if (!adminIds(env).has(claims.sub))
        return jsonResponse({ error: "Owner access required", userId: claims.sub }, request, 403);
      try {
        if (pathname === "/api/admin/carts" && request.method === "GET")
          return jsonResponse({ carts: await listCustomerCarts(env) }, request);
        if (pathname === "/api/admin/products" && request.method === "GET")
          return jsonResponse({ products: await listProducts(env, true) }, request);
        if (pathname === "/api/admin/products" && request.method === "POST")
          return jsonResponse({ product: formatProduct(await createProduct(request, env)) }, request, 201);
        const imageUpload = pathname.match(/^\/api\/admin\/products\/([^/]+)\/images$/);
        if (imageUpload && request.method === "POST") {
          const image = await uploadImage(request, env, decodeURIComponent(imageUpload[1]));
          return image ? jsonResponse({ image: formatImage(image) }, request, 201)
            : jsonResponse({ error: "Product not found" }, request, 404);
        }
        const productRoute = pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
        if (productRoute && request.method === "PUT") {
          const product = await updateProduct(request, env, decodeURIComponent(productRoute[1]));
          return product ? jsonResponse({ product: formatProduct(product) }, request)
            : jsonResponse({ error: "Product not found" }, request, 404);
        }
        if (productRoute && request.method === "DELETE")
          return await deleteProduct(env, decodeURIComponent(productRoute[1]))
            ? jsonResponse({ ok: true }, request) : jsonResponse({ error: "Product not found" }, request, 404);
        const imageRoute = pathname.match(/^\/api\/admin\/images\/([^/]+)$/);
        if (imageRoute && request.method === "DELETE")
          return await deleteImage(env, decodeURIComponent(imageRoute[1]))
            ? jsonResponse({ ok: true }, request) : jsonResponse({ error: "Image not found" }, request, 404);
      } catch (error) {
        console.error("Admin request failed", error);
        const status = /Invalid|Use a JPG|UNIQUE constraint/i.test(String(error.message)) ? 400 : 500;
        return jsonResponse({ error: status === 400 ? error.message : "Unable to complete request" }, request, status);
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return jsonResponse({ error: "Method not allowed" }, request, 405, { Allow: "GET, HEAD, OPTIONS" });
    return jsonResponse({ name: "MNMWhole API", status: "online" }, request);
  }
};
