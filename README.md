# GahahaDB

> “Dashboard queries are hammering the database?”
>
> “The customer's entire dataset is only a few hundred MB.  
> Just download the whole thing into the browser and run OLAP there.”
>
> **Gahaha.**

GahahaDB is an experimental architecture for running analytical dashboard queries entirely in the browser.

The idea is simple:

**Instead of sending every query to the server, send the data to the client once.**

```text
Traditional analytics

Browser
   |
   | query
   v
Server
   |
   | query
   v
Database
   |
   | result
   v
Browser
```

```text
GahahaDB

Server
   |
   | authorized analytical dataset
   v
Browser
   |
   +--> local OLAP engine
   |
   +--> query
   +--> filter
   +--> aggregate
   +--> visualize
```

For many dashboards, the total database may be huge while the data visible to a single customer is relatively small: tens or hundreds of megabytes, sometimes a few gigabytes.

Modern browsers run on machines with multiple CPU cores, gigabytes of memory, WebAssembly, and highly optimized analytical engines.

So instead of paying for centralized compute every time someone changes a filter:

**give the customer their data and let their computer do the work.**

GahahaDB is based on a few assumptions:

- the dataset authorized for one user or tenant is small enough to download;
- analytical queries are much more frequent than dataset updates;
- some staleness is acceptable;
- data can be represented efficiently in a columnar format;
- the browser is powerful enough to perform the required OLAP workload.

The server is still responsible for authentication, authorization, dataset generation, and delivery.

The browser is responsible for interactive analytics.

This distinction is important:

> If a byte is sent to the browser, assume the user can read it.

GahahaDB therefore does **not** move authorization into the client. Data that a user must not access must never be included in the dataset sent to that user.

The goal is not literally zero server load.

The goal is:

> **zero server-side query compute for interactive dashboard operations after the data has been delivered.**

Storage, snapshot generation, refresh, and network transfer still exist.

But if a dashboard executes hundreds of aggregations over the same few hundred megabytes of customer data, repeatedly asking a centralized OLAP server to do those aggregations may simply be unnecessary.

GahahaDB explores how far we can take the apparently ridiculous idea:

> **Just download the database. Gahaha.**

## Prototype (v0.1.0)

Zero dependencies, plain Node.js + browser ESM. No bundler, no database.

```text
src/engine/   local OLAP engine (browser + Node): columnar table, dict-encoded
              strings, declarative filter/groupBy/agg/orderBy/limit queries
src/server/   snapshot generation (builder.js) + delivery with auth (server.js)
demo/         dashboard: downloads snapshot once, then queries locally
examples/     node-demo.mjs — engine smoke test without a browser
test/         node:test suites (engine + server auth)
snapshots/    build artifacts: snapshots/<tenant>.gahaha.json (gitignored)
```

Design rules:

- The server exposes **no `/api/query`**. It only serves immutable per-tenant
  snapshots (`GET /api/snapshot/:tenantId`, `Bearer` token, ETag + 304).
- A token resolves to exactly one tenant. Bytes for tenant A are never sent
  to tenant B (`401` unknown token, `403` wrong tenant).
- The snapshot format (v1, plain JSON) is the contract: `{ version, tenantId,
  generatedAt, tables: { name: { rowCount, columns } } }`. String columns are
  `{ type: "string", dict, codes }`; numbers/booleans/dates are arrays
  (dates as epoch ms).
- Dashboard queries are declarative JSON, e.g.
  `{ filter: { op: "eq", column: "region", value: "EMEA" },
     groupBy: ["product"],
     aggregations: [{ op: "sum", column: "amount", as: "revenue" }],
     orderBy: [{ column: "revenue", desc: true }] }`,
  executed by `ColumnTable#query` entirely in the browser.
- Null semantics are SQL-like: aggregations skip nulls, empty input yields
  `count = 0` and `sum/avg/min/max = null`. Dates are strict ISO-8601 or
  `Date` instances (`"A-1"` is a string, not a date); mixed-type columns
  are rejected. Tables accept an explicit schema to pin types.

## Usage

Requires Node.js >= 18 and [pnpm](https://pnpm.io/) (pinned via
`packageManager`; Corepack-enabled environments pick it up automatically).

```sh
pnpm install            # install workspace (currently zero dependencies)
pnpm build:snapshots    # generate snapshots/acme|globex.gahaha.json
pnpm demo:node          # run dashboard queries locally (no server)
pnpm test               # engine + server auth tests (24 passing)
pnpm start              # serve demo at http://localhost:3000
```

Then open `http://localhost:3000`, pick a tenant (token auto-fills as
`token-<tenant>`), download the snapshot, and change filters — every
aggregation runs locally (see the ms readout; server round-trips: zero).

Measured on the synthetic dataset: 5000-row snapshot ≈ 252KB wire,
~2.5ms per group-by locally.

## License

Apache License 2.0
