/** Node-side smoke demo: build a table in-process and run dashboard queries. */
import { ColumnTable } from "../src/engine/index.js";
import { generateOrders } from "../src/server/builder.js";
import { encodeSnapshot, decodeSnapshot } from "../src/engine/snapshot.js";

const orders = generateOrders({ tenantId: "acme", rows: 5000, seed: 42 });
console.log(`rows=${orders.rowCount} mem~${orders.estimateBytes()}B`);

// Simulate server -> client round trip through the snapshot format.
const wire = JSON.stringify(encodeSnapshot("acme", { orders }));
console.log(`snapshot wire=${wire.length}B`);
const client = decodeSnapshot(JSON.parse(wire)).tables.orders;

// Dashboard query 1: revenue by product in EMEA.
let t0 = performance.now();
const byProduct = client.query({
  filter: { op: "eq", column: "region", value: "EMEA" },
  groupBy: ["product"],
  aggregations: [
    { op: "sum", column: "amount", as: "revenue" },
    { op: "count", as: "orders" },
  ],
  orderBy: [{ column: "revenue", desc: true }],
});
console.log(`byProduct (${(performance.now() - t0).toFixed(2)}ms local):`, byProduct.toRows());

// Dashboard query 2: global KPIs.
t0 = performance.now();
const kpis = client.query({
  aggregations: [
    { op: "sum", column: "amount", as: "revenue" },
    { op: "count", as: "orders" },
    { op: "avg", column: "amount", as: "aov" },
  ],
});
console.log(`kpis (${(performance.now() - t0).toFixed(2)}ms local):`, kpis.toRows());

// Drill-down with compound filter.
const filtered = client.query({
  filter: {
    op: "and",
    filters: [
      { op: "in", column: "status", values: ["shipped", "delivered"] },
      { op: "between", column: "amount", low: 1000, high: 100000 },
    ],
  },
  groupBy: ["status"],
  aggregations: [{ op: "count", as: "orders" }],
});
console.log("shipped/delivered 1k-100k:", filtered.toRows());
