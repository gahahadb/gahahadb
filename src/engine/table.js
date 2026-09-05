/**
 * GahahaDB local OLAP engine — dependency-free, browser + Node compatible (ESM).
 *
 * Design:
 * - Columnar in-memory table. One array per column, not one object per row.
 * - String columns are dictionary-encoded: { dict: string[], codes: Uint32Array }.
 *   Repeated low-cardinality values (region, product, status...) cost ~4 bytes/row.
 * - number/boolean/date columns are plain JS arrays (Float64/Uint8 would be the
 *   next step; kept as Array so snapshots stay plain JSON).
 * - Queries are declarative JSON ({ filter, groupBy, aggregations, orderBy, limit })
 *   so dashboard state is serializable / shareable via URL.
 */

// ---------------------------------------------------------------------------
// ColumnTable
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set(["number", "string", "boolean", "date"]);

export class ColumnTable {
  /**
   * @param {Record<string, Column>} columns
   * @param {number} rowCount
   */
  constructor(columns, rowCount) {
    this.columns = columns;
    this.rowCount = rowCount;
  }

  get columnNames() {
    return Object.keys(this.columns);
  }

  /** Build a table from an array of row objects. Infers column types. */
  static fromRows(rows) {
    if (rows.length === 0) return new ColumnTable({}, 0);
    const names = Object.keys(rows[0]);
    const types = {};
    for (const name of names) {
      types[name] = inferType(rows, name);
    }
    /** @type {Record<string, Column>} */
    const columns = {};
    for (const name of names) {
      const type = types[name];
      if (type === "string") {
        const dict = [];
        const index = new Map();
        const codes = new Uint32Array(rows.length);
        rows.forEach((r, i) => {
          const v = r[name] ?? "";
          let c = index.get(v);
          if (c === undefined) {
            c = dict.length;
            dict.push(v);
            index.set(v, c);
          }
          codes[i] = c;
        });
        columns[name] = { type, dict, codes };
      } else if (type === "date") {
        columns[name] = {
          type,
          data: rows.map((r) => toEpochMs(r[name])),
        };
      } else {
        columns[name] = { type, data: rows.map((r) => r[name] ?? null) };
      }
    }
    return new ColumnTable(columns, rows.length);
  }

  /** Cell value at (column, rowIndex), resolving string dict codes. */
  getValue(column, row) {
    const col = this.columns[column];
    if (!col) throw new Error(`unknown column: ${column}`);
    if (col.type === "string") return col.dict[col.codes[row]];
    return col.data[row];
  }

  /** Materialize rows in [offset, offset+limit). Defaults to all rows. */
  toRows(offset = 0, limit = Infinity) {
    const end = Math.min(this.rowCount, offset + limit);
    const names = this.columnNames;
    const out = [];
    for (let i = offset; i < end; i++) {
      const row = {};
      for (const n of names) row[n] = this.getValue(n, i);
      out.push(row);
    }
    return out;
  }

  /** Row count in bytes (rough estimate for demo UI). */
  estimateBytes() {
    let bytes = 0;
    for (const col of Object.values(this.columns)) {
      if (col.type === "string") {
        bytes += col.codes.length * 4;
        for (const s of col.dict) bytes += s.length * 2 + 8;
      } else if (col.type === "number" || col.type === "date") {
        const n = col.data.length;
        bytes += n * 8;
      } else {
        bytes += col.data.length * 1;
      }
    }
    return bytes;
  }

  // -- relational ops -------------------------------------------------------

  /** Filter rows. Accepts a predicate fn or a declarative filter spec (see query.js). */
  filter(specOrFn) {
    const fn =
      typeof specOrFn === "function" ? specOrFn : compileFilter(specOrFn);
    const keep = [];
    for (let i = 0; i < this.rowCount; i++) {
      if (fn((c) => this.getValue(c, i), i)) keep.push(i);
    }
    return this.takeRows(keep);
  }

  select(names) {
    const columns = {};
    for (const n of names) {
      if (!this.columns[n]) throw new Error(`unknown column: ${n}`);
      columns[n] = this.columns[n];
    }
    // share backing arrays (immutable engine: ops never mutate in place)
    return new ColumnTable(columns, this.rowCount);
  }

  takeRows(indices) {
    const columns = {};
    for (const [name, col] of Object.entries(this.columns)) {
      if (col.type === "string") {
        const codes = new Uint32Array(indices.length);
        indices.forEach((src, dst) => {
          codes[dst] = col.codes[src];
        });
        columns[name] = { type: col.type, dict: col.dict, codes };
      } else {
        columns[name] = {
          type: col.type,
          data: indices.map((i) => col.data[i]),
        };
      }
    }
    return new ColumnTable(columns, indices.length);
  }

  /**
   * Group-by + aggregation.
   * @param {string[]} keys
   * @param {Array<{op: string, column?: string, as: string}>} aggs
   *   op: count | countDistinct | sum | avg | min | max
   */
  groupBy(keys, aggs) {
    for (const k of keys) {
      if (!this.columns[k]) throw new Error(`unknown group key: ${k}`);
    }
    /** @type {Map<string, {key: Record<string, unknown>, rows: number[]}>} */
    const groups = new Map();
    for (let i = 0; i < this.rowCount; i++) {
      const keyVals = keys.map((k) => this.getValue(k, i));
      const gk = JSON.stringify(keyVals);
      let g = groups.get(gk);
      if (!g) {
        const key = {};
        keys.forEach((k, j) => {
          key[k] = keyVals[j];
        });
        g = { key, rows: [] };
        groups.set(gk, g);
      }
      g.rows.push(i);
    }
    const outRows = [];
    for (const g of groups.values()) {
      const row = { ...g.key };
      for (const agg of aggs) {
        row[agg.as] = computeAgg(this, g.rows, agg);
      }
      outRows.push(row);
    }
    return ColumnTable.fromRows(outRows);
  }

  /** @param {Array<{column: string, desc?: boolean}>} specs */
  orderBy(specs) {
    const idx = Array.from({ length: this.rowCount }, (_, i) => i);
    idx.sort((a, b) => {
      for (const s of specs) {
        const va = this.getValue(s.column, a);
        const vb = this.getValue(s.column, b);
        if (va < vb) return s.desc ? 1 : -1;
        if (va > vb) return s.desc ? -1 : 1;
      }
      return 0;
    });
    return this.takeRows(idx);
  }

  limit(n, offset = 0) {
    const idx = [];
    const end = Math.min(this.rowCount, offset + n);
    for (let i = offset; i < end; i++) idx.push(i);
    return this.takeRows(idx);
  }

  /**
   * Full dashboard query in one call (filter -> groupBy -> orderBy -> limit).
   * @param {QuerySpec} spec
   */
  query(spec) {
    let t = this;
    if (spec.filter) t = t.filter(spec.filter);
    let out;
    if (spec.groupBy && spec.groupBy.length > 0) {
      out = t.groupBy(spec.groupBy, spec.aggregations ?? [
        { op: "count", as: "count" },
      ]);
    } else if (spec.aggregations && spec.aggregations.length > 0) {
      // global aggregation (single row, no keys)
      const row = {};
      const all = Array.from({ length: t.rowCount }, (_, i) => i);
      for (const agg of spec.aggregations) {
        row[agg.as] = computeAgg(t, all, agg);
      }
      out = ColumnTable.fromRows([row]);
    } else {
      out = t;
    }
    if (spec.orderBy) out = out.orderBy(spec.orderBy);
    if (spec.limit != null) out = out.limit(spec.limit, spec.offset ?? 0);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Filter compiler (declarative JSON -> predicate)
// ---------------------------------------------------------------------------

/**
 * FilterSpec examples:
 *   { op: 'eq', column: 'region', value: 'EMEA' }
 *   { op: 'in', column: 'status', values: ['shipped','delivered'] }
 *   { op: 'between', column: 'amount', low: 100, high: 500 }
 *   { op: 'and', filters: [ ... ] } / { op: 'or', ... } / { op: 'not', filter: ... }
 *   { op: 'gte', column: 'orderedAt', value: <epoch ms> }
 */
export function compileFilter(spec) {
  if (!spec) return () => true;
  return (get, _rowIndex) => matchesFilter(spec, get);
}

export function matchesFilter(spec, get) {
  switch (spec.op) {
    case "and":
      return (spec.filters ?? []).every((f) => matchesFilter(f, get));
    case "or":
      return (spec.filters ?? []).some((f) => matchesFilter(f, get));
    case "not":
      return !matchesFilter(spec.filter, get);
    case "eq":
      return get(spec.column) === spec.value;
    case "neq":
      return get(spec.column) !== spec.value;
    case "gt":
      return get(spec.column) > spec.value;
    case "gte":
      return get(spec.column) >= spec.value;
    case "lt":
      return get(spec.column) < spec.value;
    case "lte":
      return get(spec.column) <= spec.value;
    case "in":
      return spec.values.includes(get(spec.column));
    case "between":
      return get(spec.column) >= spec.low && get(spec.column) <= spec.high;
    case "contains":
      return String(get(spec.column) ?? "").includes(String(spec.value ?? ""));
    default:
      throw new Error(`unknown filter op: ${spec.op}`);
  }
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

export function computeAgg(table, rows, agg) {
  switch (agg.op) {
    case "count":
      return rows.length;
    case "countDistinct": {
      const s = new Set(rows.map((i) => table.getValue(agg.column, i)));
      return s.size;
    }
    case "sum": {
      let acc = 0;
      for (const i of rows) acc += table.getValue(agg.column, i) ?? 0;
      return acc;
    }
    case "avg": {
      if (rows.length === 0) return null;
      let acc = 0;
      for (const i of rows) acc += table.getValue(agg.column, i) ?? 0;
      return acc / rows.length;
    }
    case "min": {
      let m = Infinity;
      for (const i of rows) {
        const v = table.getValue(agg.column, i);
        if (v < m) m = v;
      }
      return m === Infinity ? null : m;
    }
    case "max": {
      let m = -Infinity;
      for (const i of rows) {
        const v = table.getValue(agg.column, i);
        if (v > m) m = v;
      }
      return m === -Infinity ? null : m;
    }
    default:
      throw new Error(`unknown aggregation op: ${agg.op}`);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function inferType(rows, name) {
  for (const r of rows) {
    const v = r[name];
    if (v === null || v === undefined) continue;
    if (typeof v === "number") return "number";
    if (typeof v === "boolean") return "boolean";
    if (v instanceof Date) return "date";
    if (typeof v === "string" && !Number.isNaN(Date.parse(v)) && /-|T|:/u.test(v)) {
      // ISO-ish date string -> treat as date only when ALL non-null values parse?
      // Conservative: check the whole column below.
      continue;
    }
    return "string";
  }
  // second pass: all-date-strings?
  let allDate = true;
  let anyVal = false;
  for (const r of rows) {
    const v = r[name];
    if (v === null || v === undefined) continue;
    anyVal = true;
    if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
      allDate = false;
      break;
    }
  }
  if (anyVal && allDate) return "date";
  // fallback: sniff first non-null
  for (const r of rows) {
    const v = r[name];
    if (v === null || v === undefined) continue;
    if (v instanceof Date) return "date";
    if (typeof v === "number") return "number";
    if (typeof v === "boolean") return "boolean";
    return "string";
  }
  return "string";
}

function toEpochMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  return Date.parse(v);
}

/**
 * @typedef {object} Column
 * @typedef {object} QuerySpec
 */
