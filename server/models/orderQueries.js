/**
 * Questions about orders and their lines, answered by SQLite from an index
 * (models/rereviewMigration.js) instead of by reading every row of the table
 * and filtering in JavaScript.
 *
 * `orderItemsDB.query((i) => i.orderId === id)` reads and parses EVERY order
 * line there is (each carries a few kB of configuration) to find one order's:
 * with a few thousand lines in the table that is tens of milliseconds per call,
 * and the order routes made the call once per order. These helpers read the
 * rows asked for and no others. With the JSON store (USE_SQLITE=false, tests of
 * the old format) they fall back to the filter.
 */
const { ordersDB, orderItemsDB } = require("./index");

const hasSql = (store) => typeof store._query === "function";
const rows = (store, sql, params = []) => store._query(sql, params).map((r) => store._deserialize(r));

/** The lines of one order, in the order they were written. */
function itemsOf(orderId) {
  if (typeof orderId !== "string" || !orderId) return [];
  if (hasSql(orderItemsDB)) return rows(orderItemsDB, "SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid", [orderId]);
  return orderItemsDB.query((i) => i.orderId === orderId);
}

/** How many lines each of these orders has: { orderId: n }. One query for all of them. */
function itemCounts(orderIds) {
  const out = {};
  const ids = [...new Set((orderIds || []).filter((id) => typeof id === "string" && id))];
  if (ids.length === 0) return out;
  if (hasSql(orderItemsDB)) {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of orderItemsDB._query(`SELECT order_id, COUNT(*) AS n FROM order_items WHERE order_id IN (${chunk.map(() => "?").join(", ")}) GROUP BY order_id`, chunk)) out[r.order_id] = Number(r.n) || 0;
    }
    return out;
  }
  for (const it of orderItemsDB.getAll()) if (ids.includes(it.orderId)) out[it.orderId] = (out[it.orderId] || 0) + 1;
  return out;
}

/**
 * What the production queue shows of each order's lines (file, process, material, quantity), for
 * many orders in one query and without reading a line's configuration: { orderId: [line, …] }.
 */
function lineSummaries(orderIds) {
  const out = {};
  const ids = [...new Set((orderIds || []).filter((id) => typeof id === "string" && id))];
  for (const id of ids) out[id] = [];
  if (ids.length === 0) return out;
  if (hasSql(orderItemsDB)) {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      for (const r of orderItemsDB._query(`SELECT order_id, file_name, process, material_name, quantity FROM order_items WHERE order_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY rowid`, chunk)) {
        out[r.order_id].push({ fileName: r.file_name, process: r.process, materialName: r.material_name, quantity: r.quantity });
      }
    }
    return out;
  }
  for (const it of orderItemsDB.getAll()) if (out[it.orderId]) out[it.orderId].push({ fileName: it.fileName, process: it.process, materialName: it.materialName, quantity: it.quantity });
  return out;
}

/** Every order made from this quote. */
function ordersOfQuote(quoteId) {
  if (typeof quoteId !== "string" || !quoteId) return [];
  if (hasSql(ordersDB)) return rows(ordersDB, "SELECT * FROM orders WHERE quote_id = ?", [quoteId]);
  return ordersDB.query((o) => o.quoteId === quoteId);
}

/** Orders in one status (the sweep, the queue). */
function ordersInStatus(status) {
  if (hasSql(ordersDB)) return rows(ordersDB, "SELECT * FROM orders WHERE status = ?", [String(status)]);
  return ordersDB.query((o) => o.status === status);
}

/**
 * One page of orders, newest first: an account's own, or everyone's (userId null), or only the
 * flagged ones. Reads the page's rows and nothing else; an order row holds no lines and no blobs.
 * @returns {{ rows: object[], total: number, page: number, pages: number }}
 */
function page({ userId = null, flagged = false, page: wanted = 1, pageSize = 50 } = {}) {
  const size = Math.max(1, Math.min(500, Math.floor(Number(pageSize) || 50)));
  if (hasSql(ordersDB)) {
    const where = [];
    const params = [];
    if (userId) { where.push("user_id = ?"); params.push(String(userId)); }
    if (flagged) where.push("attention IS NOT NULL AND attention != ''");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(ordersDB._query(`SELECT COUNT(*) AS n FROM orders ${clause}`, params)[0].n) || 0;
    const pages = Math.max(1, Math.ceil(total / size));
    const at = Math.max(1, Math.min(pages, Math.floor(Number(wanted) || 1)));
    const found = rows(ordersDB, `SELECT * FROM orders ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, [...params, size, (at - 1) * size]);
    return { rows: found, total, page: at, pages };
  }
  const all = ordersDB.query((o) => (!userId || o.userId === userId) && (!flagged || Boolean(o.attention)))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const pages = Math.max(1, Math.ceil(all.length / size));
  const at = Math.max(1, Math.min(pages, Math.floor(Number(wanted) || 1)));
  return { rows: all.slice((at - 1) * size, at * size), total: all.length, page: at, pages };
}

/** How many orders are flagged for the owner. */
function flaggedCount() {
  if (hasSql(ordersDB)) return Number(ordersDB._query("SELECT COUNT(*) AS n FROM orders WHERE attention IS NOT NULL AND attention != ''")[0].n) || 0;
  return ordersDB.query((o) => Boolean(o.attention)).length;
}

module.exports = { itemsOf, itemCounts, lineSummaries, ordersOfQuote, ordersInStatus, page, flaggedCount, hasSql, rows };
