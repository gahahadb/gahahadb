/**
 * Snapshot builder — server side.
 *
 * Simulates the "dataset generation" step: per-tenant authorized slices are
 * materialized to snapshots/<tenantId>.gahaha.json. In production this would
 * read from Postgres/warehouse, apply authorization predicates (tenant_id = X),
 * and write columnar files (Parquet/Arrow). Here: deterministic synthetic data.
 *
 * Usage: pnpm build:snapshots
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ColumnTable } from "../engine/table.js";
import { encodeSnapshot } from "../engine/snapshot.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const outDir = join(root, "snapshots");

/** Deterministic PRNG so demos are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = ["EMEA", "APAC", "AMER"];
const PRODUCTS = ["Widget", "Gadget", "Doohickey", "Thingamajig"];
const STATUS = ["pending", "shipped", "delivered", "cancelled"];

export function generateOrders({ tenantId, rows, seed }) {
  const rand = mulberry32(seed);
  const data = [];
  const base = Date.parse("2025-01-01T00:00:00Z");
  for (let i = 0; i < rows; i++) {
    const region = REGIONS[Math.floor(rand() * REGIONS.length)];
    const product = PRODUCTS[Math.floor(rand() * PRODUCTS.length)];
    const status = STATUS[Math.floor(rand() * STATUS.length)];
    const quantity = 1 + Math.floor(rand() * 20);
    const unitPrice = 500 + Math.floor(rand() * 20000);
    data.push({
      orderId: `${tenantId.toUpperCase()}-${String(i + 1).padStart(6, "0")}`,
      customer: `cust-${1 + Math.floor(rand() * 200)}`,
      region,
      product,
      status,
      quantity,
      amount: quantity * unitPrice,
      orderedAt: base + Math.floor(rand() * 365 * 86400 * 1000),
    });
  }
  return ColumnTable.fromRows(data);
}

const TENANTS = [
  { tenantId: "acme", rows: 5000, seed: 42 },
  { tenantId: "globex", rows: 3000, seed: 1337 },
];

export function buildAll(outDirOverride) {
  const dir = outDirOverride ?? outDir;
  mkdirSync(dir, { recursive: true });
  for (const t of TENANTS) {
    const orders = generateOrders(t);
    const snapshot = encodeSnapshot(t.tenantId, { orders });
    const json = JSON.stringify(snapshot);
    writeFileSync(join(dir, `${t.tenantId}.gahaha.json`), json);
    console.log(
      `wrote snapshots/${t.tenantId}.gahaha.json rows=${t.rows} bytes=${json.length} in-memory~${orders.estimateBytes()}B`,
    );
  }
}

// Only build when run directly (`node src/server/builder.js`), not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildAll();
}
