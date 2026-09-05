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

import { ColumnTable } from "./table.js";

export const SNAPSHOT_VERSION = 1;

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
  const columns = {};
  for (const [name, col] of Object.entries(json.columns)) {
    if (col.type === "string") {
      columns[name] = {
        type: "string",
        dict: col.dict,
        codes: Uint32Array.from(col.codes),
      };
    } else {
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
  if (json.version !== SNAPSHOT_VERSION) {
    throw new Error(`unsupported snapshot version: ${json.version}`);
  }
  const tables = {};
  for (const [name, t] of Object.entries(json.tables)) {
    tables[name] = decodeTable(t);
  }
  return { tenantId: json.tenantId, generatedAt: json.generatedAt, tables };
}
