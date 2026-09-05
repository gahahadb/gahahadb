/**
 * Gahaha Snapshot format v1 — plain JSON, gzip-friendly.
 *
 * A snapshot is the ONLY thing the server sends for interactive analytics:
 * an authorized, per-tenant columnar dump. The client never asks the server
 * to filter/aggregate; it downloads once, then queries locally.
 *
 * {
 *   version: 1,
 *   tenantId: "acme",
 *   generatedAt: "2026-...",
 *   tables: {
 *     orders: {
 *       rowCount: 5000,
 *       columns: {
 *         amount:  { type: "number", data: [...] },
 *         region:  { type: "string", dict: [...], codes: [...] },
 *         orderedAt: { type: "date", data: [<epoch ms>, ...] },
 *       }
 *     }
 *   }
 * }
 */

import { ColumnTable, STRING_NULL_CODE } from "./table.js";

export const SNAPSHOT_VERSION = 1;
const VALID_TYPES = new Set(["number", "string", "boolean", "date"]);

export function encodeTable(table) {
  const columns = {};
  for (const [name, col] of Object.entries(table.columns)) {
    if (col.type === "string") {
      columns[name] = {
        type: "string",
        dict: col.dict,
        codes: Array.from(col.codes),
      };
    } else {
      columns[name] = { type: col.type, data: [...col.data] };
    }
  }
  return { rowCount: table.rowCount, columns };
}

export function decodeTable(json) {
  if (!json || typeof json.rowCount !== "number" || json.rowCount < 0) {
    throw new Error("snapshot table has an invalid rowCount");
  }
  if (!json.columns || typeof json.columns !== "object") {
    throw new Error("snapshot table has no columns");
  }
  const columns = {};
  for (const [name, col] of Object.entries(json.columns)) {
    if (!col || !VALID_TYPES.has(col.type)) {
      throw new Error(`snapshot column '${name}' has an invalid type`);
    }
    if (col.type === "string") {
      if (!Array.isArray(col.dict) || !Array.isArray(col.codes)) {
        throw new Error(`snapshot string column '${name}' needs dict + codes arrays`);
      }
      if (col.codes.length !== json.rowCount) {
        throw new Error(`snapshot string column '${name}' length mismatch`);
      }
      for (const code of col.codes) {
        if (!Number.isInteger(code) || (code >= col.dict.length && code !== STRING_NULL_CODE)) {
          throw new Error(`snapshot string column '${name}' has an out-of-range code`);
        }
      }
      columns[name] = {
        type: "string",
        dict: Object.freeze([...col.dict]),
        codes: Uint32Array.from(col.codes),
      };
    } else {
      if (!Array.isArray(col.data) || col.data.length !== json.rowCount) {
        throw new Error(`snapshot column '${name}' length mismatch`);
      }
      columns[name] = { type: col.type, data: [...col.data] };
    }
  }
  return new ColumnTable(columns, json.rowCount);
}

export function encodeSnapshot(tenantId, tables) {
  const out = { version: SNAPSHOT_VERSION, tenantId, generatedAt: new Date().toISOString(), tables: {} };
  for (const [name, table] of Object.entries(tables)) {
    out.tables[name] = encodeTable(table);
  }
  return out;
}

export function decodeSnapshot(json) {
  if (!json || json.version !== SNAPSHOT_VERSION) {
    throw new Error(`unsupported snapshot version: ${json?.version}`);
  }
  if (!json.tables || typeof json.tables !== "object") {
    throw new Error("snapshot has no tables");
  }
  const tables = {};
  for (const [name, t] of Object.entries(json.tables)) {
    tables[name] = decodeTable(t);
  }
  return { tenantId: json.tenantId, generatedAt: json.generatedAt, tables };
}
