/**
 * Snapshot delivery server — server side.
 *
 * Responsibility: authentication, authorization, dataset delivery.
 * Explicitly NOT responsible: interactive filtering/aggregation (that's the browser).
 *
 * Routes:
 *   GET /health
 *   GET /api/snapshot/:tenantId   (requires Authorization: Bearer <token>)
 *   GET /                         (demo dashboard, static)
 *
 * Auth model (demo): token -> tenant mapping. A token only ever resolves to ONE
 * tenant snapshot, so tenant A's bytes are never sent to tenant B. This is the
 * load-bearing security property: "bytes sent to the browser are readable".
 *
 * Caching: ETag (sha1 of file) + 304. Snapshots are immutable per generation;
 * refresh = client refetches (If-None-Match) on interval or on version notify.
 *
 * Zero dependencies, plain node:http.
 */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const snapshotsDir = join(root, "snapshots");
const demoDir = join(root, "demo");

export const PORT = Number(process.env.PORT ?? 3000);

// Demo tokens. In production: verify JWT/session, look up tenant ACLs in DB.
export const TOKENS = {
  "token-acme": "acme",
  "token-globex": "globex",
};

function etagFor(bytes) {
  return `"${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}"`;
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(body);
}

function sendFile(res, path, contentType) {
  const bytes = readFileSync(path);
  const etag = etagFor(bytes);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": bytes.length,
    etag,
    "cache-control": "no-cache", // revalidate with ETag each time
  });
  res.end(bytes);
  return etag;
}

export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    const snapMatch = url.pathname.match(/^\/api\/snapshot\/([\w-]+)$/);
    if (snapMatch) {
      const tenantId = snapMatch[1];
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const allowedTenant = TOKENS[token];
      if (!allowedTenant) {
        return sendJson(res, 401, { error: "missing or invalid token" });
      }
      if (allowedTenant !== tenantId) {
        // Authenticated but not authorized for this tenant's bytes.
        return sendJson(res, 403, { error: "forbidden for this tenant" });
      }
      const file = normalize(join(snapshotsDir, `${tenantId}.gahaha.json`));
      if (!file.startsWith(snapshotsDir) || !existsSync(file)) {
        return sendJson(res, 404, { error: "snapshot not found (run pnpm build:snapshots)" });
      }
      const bytes = readFileSync(file);
      const etag = etagFor(bytes);
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag });
        return res.end();
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": bytes.length,
        etag,
        "cache-control": "no-cache",
      });
      return res.end(bytes);
    }

    // Static demo (no bundler; engine imported as relative ESM path).
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return sendFile(res, join(demoDir, "index.html"), "text/html; charset=utf-8");
    }
    if (url.pathname === "/app.js") {
      return sendFile(res, join(demoDir, "app.js"), "text/javascript; charset=utf-8");
    }
    const engineMatch = url.pathname.match(/^\/engine\/(.+)$/);
    if (engineMatch) {
      const file = normalize(join(root, "src/engine", engineMatch[1]));
      if (!file.startsWith(join(root, "src/engine")) || !existsSync(file)) {
        return sendJson(res, 404, { error: "not found" });
      }
      return sendFile(res, file, "text/javascript; charset=utf-8");
    }

    return sendJson(res, 404, { error: "not found" });
  });
}

// Only listen when run directly (`node src/server/server.js`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stats = ["acme", "globex"].map((t) => {
    const f = join(snapshotsDir, `${t}.gahaha.json`);
    return existsSync(f) ? `${t}=${(statSync(f).size / 1024).toFixed(1)}KB` : `${t}=missing`;
  });
  createApp().listen(PORT, () => {
    console.log(`GahahaDB snapshot server on http://localhost:${PORT} (${stats.join(" ")})`);
    console.log(`demo tokens: Bearer token-acme / Bearer token-globex`);
  });
}
