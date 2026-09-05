import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ColumnTable } from "../src/engine/table.js";
import { encodeSnapshot, decodeSnapshot, encodeTable } from "../src/engine/snapshot.js";
import { generateOrders } from "../src/server/builder.js";

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

describe("type inference", () => {
  it("does not mistake SKU-like strings for dates", () => {
    const t = ColumnTable.fromRows([{ sku: "A-1" }, { sku: "B-2" }, { sku: "10-20" }]);
    assert.equal(t.columnTypes().sku, "string");
    assert.deepEqual(t.toRows(), [{ sku: "A-1" }, { sku: "B-2" }, { sku: "10-20" }]);
  });

  it("detects strict ISO dates and Date instances", () => {
    const t = ColumnTable.fromRows([
      { d: "2025-06-01", n: 1 },
      { d: new Date("2025-06-02T00:00:00Z"), n: 2 },
    ]);
    assert.equal(t.columnTypes().d, "date");
    assert.equal(t.getValue("d", 0), Date.parse("2025-06-01"));
  });

  it("rejects mixed-type columns", () => {
    assert.throws(() => ColumnTable.fromRows([{ x: 1 }, { x: "oops" }]), /mixed types/);
    assert.throws(() => ColumnTable.fromRows([{ x: "2025-01-01" }, { x: "hello" }]), /mixed types/);
  });

  it("unions keys across rows and keeps explicit schema when empty", () => {
    const t = ColumnTable.fromRows([{ a: 1 }, { b: "x" }]);
    assert.deepEqual(t.columnNames, ["a", "b"]);
    assert.deepEqual(t.toRows(), [
      { a: 1, b: null },
      { a: null, b: "x" },
    ]);
    const empty = ColumnTable.fromRows([], { a: "number", b: "string" });
    assert.deepEqual(empty.columnTypes(), { a: "number", b: "string" });
    assert.equal(empty.rowCount, 0);
  });

  it("builder produces a real date column for orderedAt", () => {
    const orders = generateOrders({ tenantId: "acme", rows: 100, seed: 42 });
    assert.equal(orders.columnTypes().orderedAt, "date");
  });
});

describe("null semantics", () => {
  const t = ColumnTable.fromRows([
    { g: "a", v: 10 },
    { g: "a", v: null },
    { g: "b", v: 20 },
    { g: "b", s: null },
  ]);

  it("string null is preserved and distinct from empty string", () => {
    // all four rows have s=null (explicit or missing key)
    assert.equal(t.filter({ op: "eq", column: "s", value: null }).rowCount, 4);
    assert.equal(t.filter({ op: "eq", column: "s", value: "" }).rowCount, 0);
  });

  it("aggregations skip nulls (SQL-like)", () => {
    const g = t.query({
      groupBy: ["g"],
      aggregations: [
        { op: "avg", column: "v", as: "avg" },
        { op: "sum", column: "v", as: "sum" },
        { op: "count", as: "n" },
        { op: "countDistinct", column: "v", as: "d" },
      ],
      orderBy: [{ column: "g" }],
    });
    assert.deepEqual(g.toRows(), [
      { g: "a", avg: 10, sum: 10, n: 2, d: 1 },
      { g: "b", avg: 20, sum: 20, n: 2, d: 1 },
    ]);
  });

  it("empty input yields count 0 and null for sum/avg/min/max", () => {
    const kpi = t.query({
      filter: { op: "eq", column: "g", value: "zzz" },
      aggregations: [
        { op: "count", as: "n" },
        { op: "sum", column: "v", as: "s" },
        { op: "avg", column: "v", as: "a" },
        { op: "min", column: "v", as: "mi" },
        { op: "max", column: "v", as: "ma" },
      ],
    });
    assert.deepEqual(kpi.toRows(), [{ n: 0, s: null, a: null, mi: null, ma: null }]);
  });

  it("min/max ignore null instead of comparing against it", () => {
    const u = ColumnTable.fromRows([{ v: null }, { v: 5 }, { v: -3 }]);
    const kpi = u.query({
      aggregations: [
        { op: "min", column: "v", as: "mi" },
        { op: "max", column: "v", as: "ma" },
      ],
    });
    assert.deepEqual(kpi.toRows(), [{ mi: -3, ma: 5 }]);
  });

  it("null keys form their own group and survive round-trip", () => {
    const g = t.query({ groupBy: ["s"], aggregations: [{ op: "count", as: "n" }] });
    assert.deepEqual(g.toRows(), [{ s: null, n: 4 }]);
    const back = decodeSnapshot(
      JSON.parse(JSON.stringify(encodeSnapshot("t", { g }))),
    ).tables.g;
    assert.deepEqual(back.toRows(), [{ s: null, n: 4 }]);
  });

  it("empty groupBy keeps schema instead of dropping columns", () => {
    const g = t.query({
      filter: { op: "eq", column: "g", value: "zzz" },
      groupBy: ["g"],
      aggregations: [{ op: "sum", column: "v", as: "total" }],
    });
    assert.equal(g.rowCount, 0);
    assert.deepEqual(g.columnTypes(), { g: "string", total: "number" });
  });
});

describe("filters and limits", () => {
  const t = ColumnTable.fromRows([
    { d: new Date("2025-06-15T00:00:00Z"), v: 1 },
    { d: new Date("2025-01-15T00:00:00Z"), v: 2 },
    { d: null, v: 3 },
  ]);

  it("accepts ISO strings for date columns", () => {
    const out = t.query({
      filter: { op: "between", column: "d", low: "2025-06-01", high: "2025-06-30" },
    });
    assert.deepEqual(out.toRows(), [{ d: Date.parse("2025-06-15T00:00:00Z"), v: 1 }]);
  });

  it("rejects malformed specs with clear errors", () => {
    assert.throws(() => t.filter({ op: "not" }), /requires a filter/);
    assert.throws(() => t.filter({ op: "in", column: "v" }), /requires a values array/);
    assert.throws(() => t.filter({ op: "bogus", column: "v" }), /unknown filter op/);
    assert.throws(
      () => t.groupBy(["v"], [{ op: "count", as: "v" }]),
      /collides/,
    );
  });

  it("normalizes out-of-range limits and honors offset-only queries", () => {
    assert.equal(t.limit(2, -1).rowCount, 2);
    assert.equal(t.limit(10, 99).rowCount, 0);
    const page = t.query({ orderBy: [{ column: "v" }], offset: 1 });
    assert.deepEqual(page.toRows().map((r) => r.v), [2, 3]);
  });

  it("sorts nulls first ascending", () => {
    const out = t.query({ orderBy: [{ column: "d" }] });
    assert.deepEqual(out.toRows().map((r) => r.v), [3, 2, 1]);
  });
});

describe("snapshot validation", () => {
  it("rejects corrupt snapshots", () => {
    const good = encodeTable(ColumnTable.fromRows(rows));
    assert.throws(() => decodeSnapshot({ version: 1 }), /no tables/);
    assert.throws(
      () => decodeSnapshot({ version: 1, tables: { t: { ...good, rowCount: 99 } } }),
      /mismatch/,
    );
    const badType = structuredClone(good);
    badType.columns.amount.type = "money";
    assert.throws(() => decodeSnapshot({ version: 1, tables: { t: badType } }), /invalid type/);
    const badCode = structuredClone(good);
    badCode.columns.region.codes[0] = 999;
    assert.throws(() => decodeSnapshot({ version: 1, tables: { t: badCode } }), /out-of-range/);
  });
});
