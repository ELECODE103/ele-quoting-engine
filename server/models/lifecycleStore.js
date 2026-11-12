/**
 * The order-lifecycle tables (models/orderLifecycleMigration.js), as the same kind of store
 * the rest of the app uses. Kept beside models/index.js rather than inside it so the list
 * there is not edited by every branch at once.
 */
const { SqliteDB, JsonDB, USE_SQLITE, adminAuditDB } = require("./index");

const DBClass = USE_SQLITE ? SqliteDB : JsonDB;

module.exports = {
  paymentSessionsDB: new DBClass("payment_sessions"),
  paymentEventsDB: new DBClass("payment_events"),
  adminAuditDB, // the one admin change log store (models/index.js); written only through services/audit.js
};
