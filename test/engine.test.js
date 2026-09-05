import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ColumnTable } from "../src/engine/table.js";
import { encodeSnapshot, decodeSnapshot } from "../src/engine/snapshot.js";

const rows = [
  { region: "EMEA", product: "Widget", amount: 100, qty: 1 },
  { region: "EMEA", product: "Gadget", amount: 200, qty: 2 },
  { region: "APAC", product: "Widget", amount: 300, qty: 3 },
];

describe("ColumnTable", () => {
  it("stores strings dictionary-encoded and resolves values", () => {
    const t = ColumnTable.fromRows(rows);
    assert.equal(t.rowCount, 3);
    assert.equal(t.columns.region.dict.length, 2);
    assert.equal(t.getValue("region", 0), "EMEA");
    assert.equal(t.getValue("amount", 2), 300);
  });

  it("filters with declarative specs (and/or/in/between)", () => {
    const t = ColumnTable.fromRows(rows);
    const out = t.query({
      filter: {
        op: "and",
        filters: [
          { op: "eq", column: "region", value: "EMEA" },
          { op: "between", column: "amount", low: 150, high: 250 },
        ],
      },
    });
    assert.deepEqual(out.toRows(), [rows[1]]);

    const or = t.query({
      filter: {
        op: "or",
        filters: [
          { op: "eq", column: "product", value: "Gadget" },
          { op: "in", column: "region", values: ["APAC"] },
        ],
      },
      orderBy: [{ column: "amount" }],
    });
    assert.equal(or.rowCount, 2);
  });

  it("groupBy computes sum/count/avg/min/max", () => {
    const t = ColumnTable.fromRows(rows);
    const g = t.query({
      groupBy: ["region"],
      aggregations: [
        { op: "sum", column: "amount", as: "revenue" },
        { op: "count", as: "n" },
        { op: "avg", column: "amount", as: "avg" },
        { op: "min", column: "amount", as: "min" },
        { op: "max", column: "amount", as: "max" },
      ],
      orderBy: [{ column: "revenue", desc: true }],
    });
    assert.deepEqual(g.toRows(), [
      { region: "EMEA", revenue: 300, n: 2, avg: 150, min: 100, max: 200 },
      { region: "APAC", revenue: 300, n: 1, avg: 300, min: 300, max: 300 },
    ]);
  });

  it("global aggregation + limit/offset", () => {
    const t = ColumnTable.fromRows(rows);
    const kpi = t.query({
      aggregations: [{ op: "sum", column: "amount", as: "revenue" }],
    });
    assert.deepEqual(kpi.toRows(), [{ revenue: 600 }]);

    const page = t.query({ orderBy: [{ column: "amount" }], limit: 1, offset: 1 });
    assert.deepEqual(page.toRows(), [rows[1]]);
  });

  it("snapshot round-trip preserves data", () => {
    const t = ColumnTable.fromRows(rows);
    const snap = encodeSnapshot("acme", { orders: t });
    const back = decodeSnapshot(JSON.parse(JSON.stringify(snap)));
    assert.equal(back.tenantId, "acme");
    assert.deepEqual(back.tables.orders.toRows(), rows);
  });

  it("rejects unknown columns and snapshot versions", () => {
    const t = ColumnTable.fromRows(rows);
    assert.throws(() => t.filter({ op: "eq", column: "nope", value: 1 }));
    assert.throws(() => decodeSnapshot({ version: 999, tables: {} }));
  });
});
