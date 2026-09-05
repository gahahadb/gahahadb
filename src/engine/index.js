/** Public entrypoint — works in browsers and Node (no node: imports here). */
export { ColumnTable, compileFilter, normalizeFilter, matchesFilter, computeAgg, STRING_NULL_CODE } from "./table.js";
export { encodeTable, decodeTable, encodeSnapshot, decodeSnapshot, SNAPSHOT_VERSION } from "./snapshot.js";
