export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      try {
        await env.DB.prepare("SELECT 1").first();
        await env.IMAGES.head("__connection_test__");

        return Response.json({
          ok: true,
          database: "connected",
          imageStorage: "connected"
        });
      } catch (error) {
        console.error("Health check failed", error);
        return Response.json(
          { ok: false, error: "A required storage binding is unavailable" },
          { status: 500 }
        );
      }
    }

    return Response.json({
      name: "MNMWhole API",
      status: "online"
    });
  }
};
