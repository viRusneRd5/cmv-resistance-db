// Minimal static file server for local preview of site/.
//   deno run --allow-net --allow-read scripts/serve.mjs [port]
// Tolerates large request headers (unlike `python3 -m http.server`, which
// rejects requests carrying big SSO cookies on *.uq.edu.au hostnames).

const PORT = Number(Deno.args[0] || 8000);
const ROOT = new URL("../site/", import.meta.url);
const TYPES = {
  html: "text/html", js: "text/javascript", css: "text/css",
  json: "application/json", svg: "image/svg+xml", ico: "image/x-icon",
  png: "image/png", woff2: "font/woff2", map: "application/json",
};

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  let path = decodeURIComponent(new URL(req.url).pathname);
  if (path.endsWith("/")) path += "index.html";
  if (path.includes("..")) return new Response("no", { status: 400 });
  try {
    const file = await Deno.readFile(new URL("." + path, ROOT));
    const ext = path.split(".").pop();
    return new Response(file, {
      headers: { "content-type": TYPES[ext] || "application/octet-stream" },
    });
  } catch {
    return new Response("Not found: " + path, { status: 404 });
  }
});
console.log(`Serving site/ on http://localhost:${PORT}  (also on 0.0.0.0:${PORT})`);
