/**
 * The admin's own clean-up actions (independent review 2026-11-11, H3, H4, M2):
 * before these there was nothing in the admin panel that deleted a request, an
 * attachment or a pile of junk drafts — the only cure was editing the database
 * by hand.
 *
 *   GET    /api/admin/storage                     where the database and the file folders stand
 *                                                 against their ceilings, the mail caps, and what
 *                                                 the server last cleaned up by itself
 *   POST   /api/admin/drafts/purge                { olderThanHours } — delete draft quotes of
 *                                                 visitors without an account that no order or
 *                                                 request refers to and nobody has touched for
 *                                                 that long (default 48; 0 = all of them)
 *   DELETE /api/admin/requests/:id                delete a firm-quote request and its attachment
 *                                                 (refused once the request has become an order)
 *   DELETE /api/admin/requests/:id/attachment     delete only the attachment; the request stays
 *
 * Admin only, exactly as every other admin route: a session (`authenticate`, which also refuses an unsafe
 * request without the session's CSRF token), the admin role with two-step sign-in on (`requireAdmin`
 * answers 403 `two-factor-enrolment-required` until it is), and each action that removes something is
 * written to the admin change log (services/audit.js) with how much went, never with what a customer typed.
 */
const express = require("express");
const { authenticate, requireAdmin } = require("./auth");
const { isValidUUID } = require("../middleware/validate");
const storagePressure = require("../services/storagePressure");
const mailCaps = require("../services/mailCaps");
const audit = require("../services/audit");

const router = express.Router();
const models = () => require("../models");

router.get("/admin/storage", authenticate, requireAdmin, (req, res) => {
  res.json({
    ...storagePressure.status(),
    mail: mailCaps.counters(),
    quotes: require("../security/quoteGuards").stats(),
    pricing: require("../security/pricingGate").stats(),
    parsing: require("../parsers/parsePool").pool.stats(),
  });
});

router.post("/admin/drafts/purge", authenticate, requireAdmin, async (req, res) => {
  const raw = req.body && req.body.olderThanHours;
  const hours = raw === undefined || raw === null || raw === "" ? 48 : Number(raw);
  if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 3650) return res.status(400).json({ error: "olderThanHours must be a number of hours, 0 or more." });
  try {
    const result = await storagePressure.purgeAnonymousDrafts(models(), { olderThanHours: hours });
    audit.record({ actor: req.user, area: "quotes", action: "purge-drafts", target: "draft quotes", changes: { removedDrafts: [null, result.removedDrafts], removedUnderPressure: [null, result.removedUnderPressure || 0], olderThanHours: [null, hours] } });
    console.log(`Admin: cleared ${result.removedDrafts} draft quote(s): no-account drafts idle for ${hours} h or more${result.removedUnderPressure ? `, and ${result.removedUnderPressure} more from whoever held the most because the database was over its line` : ""}`);
    res.json({ olderThanHours: hours, ...result });
  } catch (err) {
    console.error("Draft purge error:", err.message);
    res.status(500).json({ error: "The drafts could not be cleared. Try again." });
  }
});

function requestAction(action, name) {
  return (req, res) => {
    if (!isValidUUID(req.params.id)) return res.status(404).json({ error: "Request not found" });
    try {
      const result = action(models(), req.params.id);
      if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
      // The request's short reference only: its name, company, email and notes are the customer's and stay out of the log.
      audit.record({ actor: req.user, area: "request", action: name, target: String(req.params.id).slice(0, 8).toUpperCase(), entityId: req.params.id, changes: { attachmentRemoved: [null, Boolean(result.attachmentRemoved)] } });
      res.json({ deleted: true, attachmentRemoved: result.attachmentRemoved });
    } catch (err) {
      console.error("Request delete error:", err.message);
      res.status(500).json({ error: "That could not be deleted. Try again." });
    }
  };
}

router.delete("/admin/requests/:id/attachment", authenticate, requireAdmin, requestAction(storagePressure.deleteRequestAttachment, "delete-attachment"));
router.delete("/admin/requests/:id", authenticate, requireAdmin, requestAction(storagePressure.deleteRequest, "delete"));

module.exports = router;
