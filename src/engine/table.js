/**
 * GahahaDB local OLAP engine — dependency-free, browser + Node compatible (ESM).
 *
 * Design:
 * - Columnar in-memory table. One array per column, not one object per row.
 * - String columns are dictionary-encoded: { dict: string[], codes: Uint32Array }.
 *   Repeated low-cardinality values (region, product, status...) cost ~4 bytes/row.
 *   Null is preserved via a sentinel code (STRING_NULL_CODE), never coerced to "".
 * - number/boolean/date columns are plain JS arrays (Float64/Uint8 would be the
 *   next step; kept as Array so snapshots stay plain JSON). Dates are stored as
 *   epoch milliseconds; null stays null.
 * - Null semantics are SQL-like: aggregations skip nulls; an empty input yields
 *   count = 0 and sum/avg/min/max = null.
 * - Date detection is strict: Date instances or ISO-8601 strings
 *   (YYYY-MM-DD with optional time part). "A-1" or "10-20" are strings, even
 *   though Date.parse() accepts them. Mixed-type columns are rejected.
 * - Tables are immutable: ops return new tables and never mutate in place.
 *   Backing dicts are frozen and may be shared between derived tables.
 * - Queries are declarative JSON ({ filter, groupBy, aggregations, orderBy, limit })
 *   so dashboard state is serializable / shareable via URL.
 */

// ---------------------------------------------------------------------------
// ColumnTable
// ---------------------------------------------------------------------------

const VALID_TYPES = new Set(["number", "string", "boolean", "date"]);

/** Sentinel dict code meaning null in string columns (never a real dict index). */
export const STRING_NULL_CODE = 0xFFFFFFFF;

/** Strict ISO-8601: YYYY-MM-DD with optional time + optional zone. */
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

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

  /** @returns {Record<string, string>} column name -> type. */
  columnTypes() {
    const out = {};
    for (const [name, col] of Object.entries(this.columns)) out[name] = col.type;
    return out;
  }

  /**
   * Build a table from an array of row objects.
   * @param {Array<Record<string, unknown>>} rows
   * @param {Record<string, string>} [schema] explicit name -> type. Skips
   *   inference, keeps types for empty inputs, and strictly validates values.
   *   Without it, types are inferred and mixed-type columns throw.
   */
  static fromRows(rows, schema = null) {
    if (schema) validateSchema(schema);
    const names = schema ? Object.keys(schema) : unionKeys(rows);
    const types = {};
    for (const name of names) {
      types[name] = schema ? schema[name] : inferColumnType(rows, name);
    }
    /** @type {Record<string, Column>} */
    const columns = {};
    for (const name of names) {
      columns[name] = buildColumn(types[name], rows, name);
    }
    return new ColumnTable(columns, rows.length);
  }

  /** Cell value at (column, rowIndex), resolving string dict codes. */
  getValue(column, row) {
    const col = this.columns[column];
    if (!col) throw new Error(`unknown column: ${column}`);
    if (col.type === "string") {
      const code = col.codes[row];
      return code === STRING_NULL_CODE ? null : col.dict[code];
    }
    return col.data[row];
  }

  /** Materialize rows in [offset, offset+limit). Defaults to all rows. */
  toRows(offset = 0, limit = Infinity) {
    const start = clampIndex(offset, 0);
    const end = Math.min(this.rowCount, start + clampIndex(limit, Infinity));
    const names = this.columnNames;
    const out = [];
    for (let i = start; i < end; i++) {
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

  /** Filter rows. Accepts a predicate fn or a declarative filter spec. */
  filter(specOrFn) {
    const fn =
      typeof specOrFn === "function"
        ? specOrFn
        : compileFilter(normalizeFilter(specOrFn, this.columnTypes()));
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
    // share backing stores (immutable engine: ops never mutate in place,
    // dicts are frozen, so sharing is safe)
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
    validateAggs(keys, aggs, this.columnTypes());
    /** @type {Map<string, {key: Record<string, unknown>, rows: number[]}>} */
    const groups = new Map();
    for (let i = 0; i < this.rowCount; i++) {
      const keyVals = keys.map((k) => this.getValue(k, i));
      const gk = encodeGroupKey(keyVals);
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
    // Explicit schema: survives zero groups and preserves null-only columns
    // (fromRows would otherwise re-infer them as strings).
    return ColumnTable.fromRows(outRows, resultSchema(this, keys, aggs));
  }

  /** @param {Array<{column: string, desc?: boolean}>} specs */
  orderBy(specs) {
    for (const s of specs) {
      if (!this.columns[s.column]) throw new Error(`unknown column: ${s.column}`);
    }
    const idx = Array.from({ length: this.rowCount }, (_, i) => i);
    idx.sort((a, b) => {
      for (const s of specs) {
        const cmp = compareValues(this.getValue(s.column, a), this.getValue(s.column, b));
        if (cmp !== 0) return s.desc ? -cmp : cmp;
      }
      return 0;
    });
    return this.takeRows(idx);
  }

  limit(n, offset = 0) {
    const start = clampIndex(offset, 0);
    const count = clampIndex(n, 0);
    const idx = [];
    const end = Math.min(this.rowCount, start + count);
    for (let i = start; i < end; i++) idx.push(i);
    return this.takeRows(idx);
  }

  /**
   * Full dashboard query in one call (filter -> groupBy -> orderBy -> limit/offset).
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
      validateAggs([], spec.aggregations, t.columnTypes());
      const row = {};
      const all = Array.from({ length: t.rowCount }, (_, i) => i);
      for (const agg of spec.aggregations) {
        row[agg.as] = computeAgg(t, all, agg);
      }
      out = ColumnTable.fromRows([row], resultSchema(t, [], spec.aggregations));
    } else {
      out = t;
    }
    if (spec.orderBy) out = out.orderBy(spec.orderBy);
    if (spec.limit != null) {
      out = out.limit(spec.limit, spec.offset ?? 0);
    } else if (spec.offset) {
      out = out.limit(out.rowCount, spec.offset);
    }
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
 *   { op: 'gte', column: 'orderedAt', value: '2025-06-01' }  // ISO ok for date cols
 *
 * Date columns accept Date instances, epoch ms, or ISO strings as filter
 * values; they are normalized to epoch ms before comparison.
 */
export function compileFilter(spec) {
  if (!spec) return () => true;
  return (get, _rowIndex) => matchesFilter(spec, get);
}

/**
 * Validate a filter spec against known column types and normalize date
 * filter values to epoch ms. Throws on unknown columns/ops and malformed
 * specs. Returns an equivalent (possibly new) spec.
 */
export function normalizeFilter(spec, colTypes) {
  if (!spec) return spec;
  switch (spec.op) {
    case "and":
    case "or": {
      if (!Array.isArray(spec.filters)) {
        throw new Error(`filter op '${spec.op}' requires a filters array`);
      }
      return { ...spec, filters: spec.filters.map((f) => normalizeFilter(f, colTypes)) };
    }
    case "not": {
      if (!spec.filter || typeof spec.filter !== "object") {
        throw new Error("filter op 'not' requires a filter object");
      }
      return { ...spec, filter: normalizeFilter(spec.filter, colTypes) };
    }
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains": {
      assertColumn(spec, colTypes);
      if (colTypes[spec.column] === "date" && spec.op !== "contains") {
        return { ...spec, value: toEpochMsStrict(spec.value) };
      }
      return spec;
    }
    case "in": {
      assertColumn(spec, colTypes);
      if (!Array.isArray(spec.values)) {
        throw new Error("filter op 'in' requires a values array");
      }
      if (colTypes[spec.column] === "date") {
        return { ...spec, values: spec.values.map(toEpochMsStrict) };
      }
      return spec;
    }
    case "between": {
      assertColumn(spec, colTypes);
      if (colTypes[spec.column] === "date") {
        return { ...spec, low: toEpochMsStrict(spec.low), high: toEpochMsStrict(spec.high) };
      }
      return spec;
    }
    default:
      throw new Error(`unknown filter op: ${spec.op}`);
  }
}

function assertColumn(spec, colTypes) {
  if (!spec.column || !(spec.column in colTypes)) {
    throw new Error(`unknown column: ${spec.column}`);
  }
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
// Aggregations (SQL-like null semantics: nulls are skipped)
// ---------------------------------------------------------------------------

export function computeAgg(table, rows, agg) {
  switch (agg.op) {
    case "count":
      return rows.length;
    case "countDistinct": {
      const s = new Set();
      for (const i of rows) {
        const v = table.getValue(agg.column, i);
        if (v !== null && v !== undefined) s.add(distinctKey(v));
      }
      return s.size;
    }
    case "sum": {
      let acc = 0;
      let seen = false;
      for (const i of rows) {
        const v = table.getValue(agg.column, i);
        if (v === null || v === undefined) continue;
        acc += v;
        seen = true;
      }
      return seen ? acc : null;
    }
    case "avg": {
      let acc = 0;
      let n = 0;
      for (const i of rows) {
        const v = table.getValue(agg.column, i);
        if (v === null || v === undefined) continue;
        acc += v;
        n++;
      }
      return n > 0 ? acc / n : null;
    }
    case "min": {
      let m = null;
      for (const i of rows) {
        const v = table.getValue(agg.column, i);
        if (v === null || v === undefined) continue;
        if (m === null || v < m) m = v;
      }
      return m;
    }
    case "max": {
      let m = null;
      for (const i of rows) {
        const v = table.getValue(agg.column, i);
        if (v === null || v === undefined) continue;
        if (m === null || v > m) m = v;
      }
      return m;
    }
    default:
      throw new Error(`unknown aggregation op: ${agg.op}`);
  }
}

/** Aggregation output schema so groupBy results keep types even when empty. */
function resultSchema(table, keys, aggs) {
  const types = table.columnTypes();
  const schema = {};
  for (const k of keys) schema[k] = types[k];
  for (const agg of aggs) {
    if (agg.op === "count" || agg.op === "countDistinct") {
      schema[agg.as] = "number";
    } else if (agg.op === "sum" || agg.op === "avg") {
      schema[agg.as] = "number";
    } else {
      // min/max preserve the input column type
      schema[agg.as] = types[agg.column];
    }
  }
  return schema;
}

function validateAggs(keys, aggs, colTypes) {
  const seen = new Set(keys);
  for (const agg of aggs ?? []) {
    if (!agg.as) throw new Error("aggregation requires an 'as' name");
    if (seen.has(agg.as)) {
      throw new Error(`aggregation output '${agg.as}' collides with a group key or sibling`);
    }
    seen.add(agg.as);
    if (agg.op !== "count") {
      if (!agg.column || !(agg.column in colTypes)) {
        throw new Error(`unknown column: ${agg.column}`);
      }
    }
    if (!["count", "countDistinct", "sum", "avg", "min", "max"].includes(agg.op)) {
      throw new Error(`unknown aggregation op: ${agg.op}`);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validateSchema(schema) {
  for (const [name, type] of Object.entries(schema)) {
    if (!VALID_TYPES.has(type)) {
      throw new Error(`invalid type '${type}' for column '${name}'`);
    }
  }
}

/** Ordered union of keys across all rows (not just the first row). */
function unionKeys(rows) {
  const names = [];
  const seen = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        names.push(k);
      }
    }
  }
  return names;
}

function buildColumn(type, rows, name) {
  if (type === "string") {
    const dict = [];
    const index = new Map();
    const codes = new Uint32Array(rows.length);
    rows.forEach((r, i) => {
      const v = r[name];
      if (v === null || v === undefined) {
        codes[i] = STRING_NULL_CODE;
        return;
      }
      const s = String(v);
      let c = index.get(s);
      if (c === undefined) {
        c = dict.length;
        if (c === STRING_NULL_CODE) throw new Error("string dictionary overflow");
        dict.push(s);
        index.set(s, c);
      }
      codes[i] = c;
    });
    return { type, dict: Object.freeze(dict), codes };
  }
  if (type === "date") {
    return { type, data: rows.map((r) => coerceDate(r[name], name)) };
  }
  if (type === "number") {
    return {
      type,
      data: rows.map((r) => {
        const v = r[name];
        if (v === null || v === undefined) return null;
        if (typeof v !== "number") {
          throw new TypeError(`column '${name}' expects number, got ${typeof v}`);
        }
        return v;
      }),
    };
  }
  // boolean
  return {
    type,
    data: rows.map((r) => {
      const v = r[name];
      if (v === null || v === undefined) return null;
      if (typeof v !== "boolean") {
        throw new TypeError(`column '${name}' expects boolean, got ${typeof v}`);
      }
      return v;
    }),
  };
}

function coerceDate(v, name) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const ms = v.getTime();
    if (Number.isNaN(ms)) throw new TypeError(`column '${name}' has an invalid Date`);
    return ms;
  }
  if (typeof v === "number") return v;
  if (typeof v === "string" && isIsoDateString(v)) return Date.parse(v);
  throw new TypeError(`column '${name}' expects a Date, epoch ms, or ISO-8601 string`);
}

function isIsoDateString(s) {
  return ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

/**
 * Infer a column type from ALL non-null values. Strict: Date means Date
 * instances or ISO-8601 strings only; any other mix of runtime types throws.
 * All-null columns default to string (pass an explicit schema to override).
 */
function inferColumnType(rows, name) {
  let type = null;
  for (const r of rows) {
    const v = r[name];
    if (v === null || v === undefined) continue;
    const t =
      v instanceof Date || (typeof v === "string" && isIsoDateString(v))
        ? "date"
        : typeof v;
    if (t !== "number" && t !== "string" && t !== "boolean" && t !== "date") {
      throw new TypeError(`column '${name}' has unsupported value of type ${t}`);
    }
    if (type === null) {
      type = t;
    } else if (type !== t) {
      throw new TypeError(
        `column '${name}' has mixed types (${type} and ${t}); pass an explicit schema`,
      );
    }
  }
  return type ?? "string";
}

/** Strict epoch-ms coercion for date filter values. Null passes through. */
function toEpochMsStrict(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string" && isIsoDateString(v)) return Date.parse(v);
  throw new TypeError(`expected a Date, epoch ms, or ISO-8601 string, got ${JSON.stringify(v)}`);
}

/**
 * Stable group/distinct key encoding. Unlike JSON.stringify, null, undefined,
 * NaN and +/-Infinity each form their own group instead of collapsing to null.
 * Parts are length-prefixed, so concatenation can never collide between
 * different key tuples (a plain joiner could: ["a s s::b"] vs ["a", "s:b"]).
 */
function encodeGroupKey(vals) {
  return vals.map(distinctKey).join("");
}

function distinctKey(v) {
  if (v === null) return framed("z", "null");
  if (v === undefined) return framed("z", "undef");
  switch (typeof v) {
    case "number":
      if (Number.isNaN(v)) return framed("n", "nan");
      if (v === Infinity) return framed("n", "+inf");
      if (v === -Infinity) return framed("n", "-inf");
      return framed("n", Object.is(v, -0) ? "-0" : String(v));
    case "string":
      return framed("s", v);
    case "boolean":
      return framed("b", String(v));
    default:
      return framed(typeof v, String(v));
  }
}

function framed(tag, str) {
  return `${tag}:${str.length}:${str};`;
}

/** Total order with null/NaN treated as missing (sorts first ascending). */
function compareValues(a, b) {
  const am = a === null || a === undefined || (typeof a === "number" && Number.isNaN(a));
  const bm = b === null || b === undefined || (typeof b === "number" && Number.isNaN(b));
  if (am && bm) return 0;
  if (am) return -1;
  if (bm) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Coerce to a safe non-negative integer (Infinity allowed as "no limit"). */
function clampIndex(v, fallback) {
  if (typeof v !== "number" || Number.isNaN(v)) return fallback;
  const n = Math.trunc(v);
  if (!Number.isFinite(n)) return n < 0 ? 0 : n; // keep Infinity, clamp -Infinity
  return Math.max(0, n);
}

function rowKeys(row) {
  return Object.keys(row);
}

/**
 * @typedef {{type: string, data?: Array<unknown>, dict?: string[], codes?: Uint32Array}} Column
 * @typedef {{op: string, column?: string, as: string}} Aggregation
 * @typedef {{filter?: object, groupBy?: string[], aggregations?: Aggregation[], orderBy?: Array<{column: string, desc?: boolean}>, limit?: number, offset?: number}} QuerySpec
 */
