import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server/server.js";
import { generateOrders } from "../src/server/builder.js";
import { encodeSnapshot } from "../src/engine/snapshot.js";

describe("snapshot server auth", () => {
  let server;
  let base;
  let snapshotsDir;
  before(async () => {
    // Fixture lives in an isolated tmpdir: tests must never overwrite
    // the real snapshots/ used by the demo.
    snapshotsDir = mkdtempSync(join(tmpdir(), "gahaha-test-"));
    mkdirSync(snapshotsDir, { recursive: true });
    const orders = generateOrders({ tenantId: "acme", rows: 50, seed: 7 });
    writeFileSync(
      join(snapshotsDir, "acme.gahaha.json"),
      JSON.stringify(encodeSnapshot("acme", { orders })),
    );
    server = createApp({ snapshotsDir });
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://localhost:${server.address().port}`;
  });
  after(() => {
    server.close();
    rmSync(snapshotsDir, { recursive: true, force: true });
  });

  it("401 without token, 403 for wrong tenant, 200 + 304 with correct token", async () => {
    assert.equal((await fetch(`${base}/api/snapshot/acme`)).status, 401);

    const forbidden = await fetch(`${base}/api/snapshot/acme`, {
      headers: { Authorization: "Bearer token-globex" },
    });
    assert.equal(forbidden.status, 403);

    const ok = await fetch(`${base}/api/snapshot/acme`, {
      headers: { Authorization: "Bearer token-acme" },
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
  });

  it("404 for tenants without a snapshot", async () => {
    const res = await fetch(`${base}/api/snapshot/globex`, {
      headers: { Authorization: "Bearer token-globex" },
    });
    assert.equal(res.status, 404);
  });
});
