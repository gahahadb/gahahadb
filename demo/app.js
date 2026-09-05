/** Demo dashboard: fetch snapshot once, query with the local engine. */
import { decodeSnapshot } from "/engine/index.js";

let snapshot = null;

const $ = (id) => document.getElementById(id);

$("tenant").addEventListener("change", (e) => {
  $("token").value = `token-${e.target.value}`;
});

$("load").addEventListener("click", async () => {
  const tenant = $("tenant").value;
  const token = $("token").value;
  const t0 = performance.now();
  const res = await fetch(`/api/snapshot/${tenant}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    $("meta").textContent = `load failed: ${res.status} ${await res.text()}`;
    return;
  }
  const json = await res.json();
  snapshot = decodeSnapshot(json);
  const dt = (performance.now() - t0).toFixed(0);
  const orders = snapshot.tables.orders;
  $("meta").textContent =
    `tenant=${snapshot.tenantId} rows=${orders.rowCount} ` +
    `wire=${JSON.stringify(json).length}B in-memory~${orders.estimateBytes()}B ` +
    `downloaded in ${dt}ms (query compute from here on: 0 server round-trips)`;
  runQuery();
});

$("run").addEventListener("click", runQuery);
$("region").addEventListener("change", runQuery);
$("groupBy").addEventListener("change", runQuery);

function runQuery() {
  if (!snapshot) return;
  const orders = snapshot.tables.orders;
  const region = $("region").value;
  const groupBy = $("groupBy").value;

  const spec = {
    ...(region ? { filter: { op: "eq", column: "region", value: region } } : {}),
    groupBy: [groupBy],
    aggregations: [
      { op: "sum", column: "amount", as: "revenue" },
      { op: "count", as: "orders" },
      { op: "avg", column: "amount", as: "avgOrder" },
    ],
    orderBy: [{ column: "revenue", desc: true }],
  };

  const t0 = performance.now();
  const result = orders.query(spec);
  const dt = performance.now() - t0;
  const rows = result.toRows();

  $("timing").textContent =
    `${rows.length} groups × ${orders.rowCount} rows scanned locally in ${dt.toFixed(2)}ms — server compute: none`;

  const thead = $("result").querySelector("thead");
  const tbody = $("result").querySelector("tbody");
  thead.innerHTML = `<tr><th>${groupBy}</th><th>revenue</th><th>orders</th><th>avgOrder</th></tr>`;
  tbody.innerHTML = rows
    .map(
      (r) =>
        `<tr><td>${r[groupBy]}</td><td>${Math.round(r.revenue).toLocaleString()}</td>` +
        `<td>${r.orders.toLocaleString()}</td><td>${Math.round(r.avgOrder).toLocaleString()}</td></tr>`,
    )
    .join("");

  drawBars(rows, groupBy);
}

function drawBars(rows, labelKey) {
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (rows.length === 0) return;
  const max = Math.max(...rows.map((r) => r.revenue));
  const bw = canvas.width / rows.length;
  rows.forEach((r, i) => {
    const h = (r.revenue / max) * (canvas.height - 30);
    ctx.fillRect(i * bw + 8, canvas.height - 20 - h, bw - 16, h);
    ctx.fillText(String(r[labelKey]), i * bw + 8, canvas.height - 6, bw - 16);
  });
}
