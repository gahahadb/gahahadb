import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, TOKENS } from "../src/server/server.js";
import { generateOrders } from "../src/server/builder.js";
import { encodeSnapshot } from "../src/engine/snapshot.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotsDir = join(root, "snapshots");

describe("snapshot server auth", () => {
  let server;
  let base;
  before(async () => {
    // ensure a fixture snapshot exists
    mkdirSync(snapshotsDir, { recursive: true });
    const orders = generateOrders({ tenantId: "acme", rows: 50, seed: 7 });
    writeFileSync(
      join(snapshotsDir, "acme.gahaha.json"),
      JSON.stringify(encodeSnapshot("acme", { orders })),
    );
    server = createApp();
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://localhost:${server.address().port}`;
  });
  after(() => server.close());

  it("401 without token, 403 for wrong tenant, 200 + 304 with correct token", async () => {
    assert.equal((await fetch(`${base}/api/snapshot/acme`)).status, 401);

    const forbidden = await fetch(`${base}/api/snapshot/acme`, {
      headers: { Authorization: "Bearer token-globex" },
    });
    assert.equal(forbidden.status, 403);

    const ok = await fetch(`${base}/api/snapshot/acme`, {
      headers: { Authorization: `Bearer token-acme` },
    });
    assert.equal(ok.status, 200);
    assert.ok(ok.headers.get("etag"));
    const body = await ok.json();
    assert.equal(body.tenantId, "acme");

    const cached = await fetch(`${base}/api/snapshot/acme`, {
      headers: {
        Authorization: "Bearer token-acme",
        "If-None-Match": ok.headers.get("etag"),
      },
    });
    assert.equal(cached.status, 304);
    assert.ok(TOKENS["token-acme"]);
  });
});
