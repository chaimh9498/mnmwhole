const ALLOWED_ORIGINS = new Set([
  "https://mnmwhole.com",
  "https://www.mnmwhole.com"
]);

function corsHeaders(request) {
  const headers = new Headers({ Vary: "Origin" });
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function jsonResponse(data, request, status = 200, extraHeaders = {}) {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function productImageUrl(key) {
  return `/images/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function formatImage(image) {
  return {
    id: image.id,
    url: productImageUrl(image.object_key),
    altText: image.alt_text,
    sortOrder: image.sort_order
  };
}

function formatProduct(product, images = []) {
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    sku: product.sku,
    category: product.category,
    description: product.description,
    priceCents: product.price_cents,
    stock: product.stock,
    featured: Boolean(product.featured),
    images: images.map(formatImage),
    createdAt: product.created_at,
    updatedAt: product.updated_at
  };
}

async function listProducts(env) {
  const productResult = await env.DB.prepare(`
    SELECT *
    FROM products
    WHERE active = 1
    ORDER BY featured DESC, created_at DESC
    LIMIT 200
  `).all();

  const products = productResult.results || [];
  if (products.length === 0) return [];

  let images = [];
  try {
    const imageResult = await env.DB.prepare(`
      SELECT i.*
      FROM product_images AS i
      INNER JOIN products AS p ON p.id = i.product_id
      WHERE p.active = 1
      ORDER BY i.product_id, i.sort_order, i.created_at
    `).all();
    images = imageResult.results || [];
  } catch (error) {
    console.warn("Product images could not be loaded", error);
  }

  const imagesByProduct = new Map();
  for (const image of images) {
    const images = imagesByProduct.get(image.product_id) || [];
    images.push(image);
    imagesByProduct.set(image.product_id, images);
  }

  return products.map((product) =>
    formatProduct(product, imagesByProduct.get(product.id) || [])
  );
}

async function getProductBySlug(env, slug) {
  const product = await env.DB.prepare(`
    SELECT id, name, slug, sku, category, description, price_cents,
           stock, featured, created_at, updated_at
    FROM products
    WHERE active = 1 AND slug = ?
    LIMIT 1
  `).bind(slug).first();

  if (!product) return null;

  const imageResult = await env.DB.prepare(`
    SELECT id, product_id, object_key, alt_text, sort_order
    FROM product_images
    WHERE product_id = ?
    ORDER BY sort_order, created_at
  `).bind(product.id).all();

  return formatProduct(product, imageResult.results || []);
}

async function serveImage(request, env, key) {
  if (!key) {
    return jsonResponse({ error: "Image not found" }, request, 404);
  }

  const object = request.method === "HEAD"
    ? await env.IMAGES.head(key)
    : await env.IMAGES.get(key);

  if (!object) {
    return jsonResponse({ error: "Image not found" }, request, 404);
  }

  const headers = corsHeaders(request);
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      const headers = corsHeaders(request);
      headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }

    if (request.method === "GET" && pathname === "/health") {
      try {
        await env.DB.prepare("SELECT 1").first();
        await env.IMAGES.head("__connection_test__");
        return jsonResponse({
          ok: true,
          database: "connected",
          imageStorage: "connected"
        }, request);
      } catch (error) {
        console.error("Health check failed", error);
        return jsonResponse({
          ok: false,
          error: "A required storage binding is unavailable"
        }, request, 500);
      }
    }

    if (request.method === "GET" && pathname === "/api/products") {
      try {
        return jsonResponse({ products: await listProducts(env) }, request);
      } catch (error) {
        console.error("Product listing failed", error);
        return jsonResponse({ error: "Unable to load products" }, request, 500);
      }
    }

    if (request.method === "GET" && pathname.startsWith("/api/products/")) {
      try {
        const slug = decodeURIComponent(pathname.slice("/api/products/".length));
        const product = await getProductBySlug(env, slug);
        return product
          ? jsonResponse({ product }, request)
          : jsonResponse({ error: "Product not found" }, request, 404);
      } catch (error) {
        console.error("Product lookup failed", error);
        return jsonResponse({ error: "Unable to load product" }, request, 500);
      }
    }

    if ((request.method === "GET" || request.method === "HEAD") && pathname.startsWith("/images/")) {
      try {
        const key = decodeURIComponent(pathname.slice("/images/".length));
        return await serveImage(request, env, key);
      } catch (error) {
        console.error("Image delivery failed", error);
        return jsonResponse({ error: "Unable to load image" }, request, 500);
      }
    }

    if (pathname.startsWith("/api/admin/")) {
      return jsonResponse({
        error: "Admin API is disabled until Clerk authentication is configured"
      }, request, 503);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonResponse({ error: "Method not allowed" }, request, 405, {
        Allow: "GET, HEAD, OPTIONS"
      });
    }

    return jsonResponse({
      name: "MNMWhole API",
      status: "online",
      endpoints: ["/health", "/api/products", "/api/products/:slug", "/images/:key"]
    }, request);
  }
};
