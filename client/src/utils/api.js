/**
 * API client — all backend communication goes through here.
 *
 * The session lives in an httpOnly cookie the browser sends by itself; script
 * never sees it. What script does hold is the CSRF token for that session
 * (from /api/auth/session), sent as X-CSRF-Token on every request that changes
 * something, and the quote tool's verified-human token (X-Human-Token).
 */
import { ensureHuman, getHumanToken } from './security';
import { describeRefusal, contextFor } from './messages';

const BASE = '/api';

let csrfToken = null;
export function setCsrfToken(token) { csrfToken = token || null; }

// Told when the server says the session is over (signed out elsewhere, password changed, expired).
let onSessionEnded = null;
export function setSessionEndedHandler(fn) { onSessionEnded = fn; }

/** Headers every call carries: CSRF for writes, and the verified-human token when there is one. */
function baseHeaders(method = 'GET') {
  const headers = {};
  if (csrfToken && method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrfToken;
  const human = getHumanToken();
  if (human) headers['X-Human-Token'] = human;
  return headers;
}

// Told when the server refuses an admin request because two-step sign-in is not switched on yet.
let onEnrolmentRequired = null;
export function setEnrolmentRequiredHandler(fn) { onEnrolmentRequired = fn; }

/**
 * A refusal, as an Error the pages can show as it is: `message` is the buyer's
 * wording for this code in this place (utils/messageCatalogue.js), and the
 * rest is there for the page that wants to do more than show it:
 *   code, status, data (the server's JSON), action ('rfq' | 'retry' | 'reset' |
 *   'sign-in' | 'reload' | 'reopen-quote' | null), serverMessage (what the
 *   server itself said, for the console and the admin screens).
 */
function refusal({ status, data, path, method, context }) {
  const where = context || contextFor(path, method);
  const said = describeRefusal({ status, code: data.code, serverMessage: data.error, data, context: where });
  return Object.assign(new Error(said.message), { status, code: data.code, data, action: said.action, context: where, serverMessage: data.error || '' });
}

async function failure(res, { path = '', method = 'GET', context } = {}) {
  const data = await res.json().catch(() => ({}));
  // The session is over (signed out elsewhere, password changed, expired), or the cookie is gone while
  // this page still thought it was signed in: tell the app, which sends the buyer to sign in and back.
  if (res.status === 401 && onSessionEnded && (data.code === 'session-ended' || (data.code === 'auth-required' && csrfToken))) onSessionEnded();
  if (res.status === 403 && data.code === 'two-factor-enrolment-required' && onEnrolmentRequired) onEnrolmentRequired();
  return refusal({ status: res.status, data, path, method, context });
}

/** fetch, with "the server did not answer" turned into the same kind of Error as a refusal. */
async function send(path, init, context) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw refusal({ status: 0, data: {}, path, method: init.method || 'GET', context });
  }
  if (!res.ok) throw await failure(res, { path, method: init.method || 'GET', context });
  return res;
}

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const { context, ...init } = options;
  const res = await send(path, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...baseHeaders(method), ...init.headers },
  }, context);
  return res.json();
}

/** A multipart POST (files). `headers` are added to the usual ones. */
async function postForm(path, form, headers = {}, context) {
  const res = await send(path, { method: 'POST', body: form, credentials: 'same-origin', headers: { ...baseHeaders('POST'), ...headers } }, context);
  return res.json();
}

/**
 * Quote-tool calls that sit behind the bot check: make sure the check has been
 * passed, and if the server still asks for it (the hour is up), run it again
 * and retry once.
 */
async function gated(call) {
  await ensureHuman();
  try {
    return await call();
  } catch (err) {
    if (err.code !== 'human-check-required') throw err;
    await ensureHuman({ force: true });
    return call();
  }
}

export const api = {
  // File upload
  // `process` (optional) lets the server refuse a DXF for anything but routing.
  async uploadFiles(files, process) {
    return gated(() => {
      const form = new FormData();
      if (process) form.append('process', process); // before the files
      for (const f of files) form.append('files', f);
      return postForm('/upload', form);
    });
  },

  // DXF only: confirm or change the drawing units ("mm" | "in"); returns the re-read part.
  // `editKey` came back with the upload: only the browser that holds it may change the part.
  async setPartUnits(partId, units, editKey) {
    return gated(() => request(`/parts/${partId}/units`, { method: 'POST', body: JSON.stringify({ units }), headers: { 'X-Part-Key': editKey || '' } }));
  },

  // Quote
  /** Price the parts. `extra.quoteId` names the session's quote so it is updated, not re-created. */
  async getQuote(parts, leadTimeSlug = 'standard', extra = {}) {
    return gated(() => request('/quote', {
      method: 'POST',
      body: JSON.stringify({ parts, leadTimeSlug, ...extra }),
    }));
  },

  /**
   * Parts + configuration of a saved quote, to reopen it in the builder.
   * The server sends each line's configuration (`parts`) and each distinct part once (`partsById`);
   * here they are put back together as one entry per line, which is what the builder works with.
   * Previews are not in the answer: each part says where its own is (`mesh.url`, see partLoader.js).
   */
  async getQuoteSession(id) {
    const saved = await gated(() => request(`/quote/${id}/session`));
    const byId = saved.partsById || {};
    return { ...saved, parts: (saved.parts || []).map((line) => ({ ...(byId[line.partId] || {}), ...line })) };
  },

  /** A part's preview mesh or geometry detail, from the URL the server gave for it. Only the browser that holds the part's key may fetch it. */
  async getPartPayload(url, editKey) {
    const path = String(url || '').replace(/^\/api/, '');
    return gated(() => request(path, { headers: { 'X-Part-Key': editKey || '' } }));
  },

  async uploadQuoteDrawing(quoteId, file) {
    return gated(() => {
      const form = new FormData();
      form.append('drawing', file);
      return postForm(`/quote/${quoteId}/drawing`, form);
    });
  },
  async removeQuoteDrawing(quoteId) { return request(`/quote/${quoteId}/drawing`, { method: 'DELETE' }); },

  async getQuoteById(id) {
    return request(`/quote/${id}`);
  },

  // Config (public)
  async getProcesses() { return request('/processes'); },
  async getMaterials(process) {
    return request(`/materials${process ? `?process=${process}` : ''}`);
  },
  async getFinishes(process) {
    return request(`/finishes${process ? `?process=${process}` : ''}`);
  },
  async getLeadTimes() { return request('/lead-times'); },

  // Admin
  async getAdminMaterials() { return request('/admin/materials'); },
  async updateMaterial(id, data) {
    return request(`/admin/materials/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },
  async createMaterial(data) {
    return request('/admin/materials', { method: 'POST', body: JSON.stringify(data) });
  },
  async deleteMaterial(id) {
    return request(`/admin/materials/${id}`, { method: 'DELETE' });
  },

  async getAdminFinishes() { return request('/admin/finishes'); },
  async updateFinish(id, data) {
    return request(`/admin/finishes/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },
  async createFinish(data) {
    return request('/admin/finishes', { method: 'POST', body: JSON.stringify(data) });
  },

  async duplicateMaterial(id) {
    return request(`/admin/materials/${id}/duplicate`, { method: 'POST' });
  },

  // Pricing console
  async getPricingSchema() { return request('/admin/pricing/schema'); },
  async getPricingRules() { return request('/admin/pricing'); },
  /** Save changed rules with a one-line note (required; it goes in the history). */
  async updatePricingRules(rules, note) {
    return request('/admin/pricing', { method: 'PUT', body: JSON.stringify({ rules, note }) });
  },
  async previewPricing(rules) {
    return request('/admin/pricing/preview', { method: 'POST', body: JSON.stringify({ rules }) });
  },
  async getPricingHistory(limit = 50) { return request(`/admin/pricing/history?limit=${limit}`); },
  async restorePricing(id) {
    return request(`/admin/pricing/restore/${id}`, { method: 'POST', body: JSON.stringify({}) });
  },
  async resetPricing() {
    return request('/admin/pricing/reset', { method: 'POST', body: JSON.stringify({}) });
  },

  // Calibration
  async getCalibration() { return request('/admin/calibration'); },
  async updateOrderItemActuals(itemId, data) {
    return request(`/admin/order-items/${itemId}/actuals`, { method: 'PUT', body: JSON.stringify(data) });
  },

  async getAdminLeadTimes() { return request('/admin/lead-times'); },
  async updateLeadTime(id, data) {
    return request(`/admin/lead-times/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },

  async getAdminQuotes() { return request('/admin/quotes'); },
  /** Who changed what and when (materials, finishes, lead times, pricing rules, order status). */
  async getAdminAudit() { return request('/admin/audit'); },
  /** End the price hold on every open quote (after a price change): buyers reopen the quote to get today's price. */
  async voidOpenQuotes(note) { return request('/admin/quotes/void-open', { method: 'POST', body: JSON.stringify({ note }) }); },
  async getAdminStats() { return request('/admin/stats'); },
  async getAdminParts() { return request('/admin/parts'); },
  // Admin → System (server/ops)
  async getSystemStatus() { return request('/admin/system/status'); },
  async sendSystemEmailTest() { return request('/admin/system/email-test', { method: 'POST', body: '{}' }); },
  async sendSystemDigest() { return request('/admin/system/digest', { method: 'POST', body: '{}' }); },

  // Auth. `guard` = the form-token and bot-check headers from useFormGuard.
  async login(email, password, extra = {}, guard = {}) {
    return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, ...extra }), headers: guard, context: extra.recoveryCode ? 'recovery-code' : 'login' });
  },
  async register(fields, guard = {}) {
    return request('/auth/register', { method: 'POST', body: JSON.stringify(fields), headers: guard });
  },
  /** One-time setup of the admin account: the owner's setup code and a new password. */
  async adminSetup(code, password) {
    return request('/auth/admin-setup', { method: 'POST', body: JSON.stringify({ code, password }) });
  },
  async getSession() { return request('/auth/session'); },
  async logout() { return request('/auth/logout', { method: 'POST', body: '{}' }); },
  async verifyEmail(token) { return request('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }); },
  async resendVerification() { return request('/auth/verify-email/resend', { method: 'POST', body: '{}' }); },
  async requestPasswordReset(fields, guard = {}) {
    return request('/auth/password-reset/request', { method: 'POST', body: JSON.stringify(fields), headers: guard });
  },
  async checkPasswordReset(token) { return request('/auth/password-reset/check', { method: 'POST', body: JSON.stringify({ token }) }); },
  async confirmPasswordReset(token, password) {
    return request('/auth/password-reset/confirm', { method: 'POST', body: JSON.stringify({ token, password }) });
  },
  // Two-step sign-in (admin)
  async getTwoFactor() { return request('/auth/2fa'); },
  async setupTwoFactor(password) { return request('/auth/2fa/setup', { method: 'POST', body: JSON.stringify({ password }) }); },
  async enableTwoFactor(code) { return request('/auth/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) }); },
  async newRecoveryCodes(code) { return request('/auth/2fa/recovery-codes', { method: 'POST', body: JSON.stringify({ code }) }); },
  async disableTwoFactor(fields) { return request('/auth/2fa/disable', { method: 'POST', body: JSON.stringify(fields) }); },
  // Bot check
  async getFormToken(form) { return request(`/public/form-token?form=${encodeURIComponent(form)}`); },
  async verifyHuman(turnstileToken) { return request('/human/verify', { method: 'POST', body: JSON.stringify({ turnstileToken, action: 'quote' }) }); },

  // Orders
  async getOrders() { return request('/orders'); },
  async getOrderById(id) { return request(`/orders/${id}`); },
  /** Ask the server to check with Stripe whether a just-placed order has been paid. */
  async confirmOrderPayment(id) { return request(`/orders/${id}/confirm-payment`, { method: 'POST', body: '{}' }); },
  /** Re-quote an order's parts at today's prices; returns { quoteId } for the builder. */
  async reorder(id) { return request(`/orders/${id}/reorder`, { method: 'POST', body: '{}' }); },
  async downloadOrderDrawing(id, fileName) {
    const res = await send(`/orders/${id}/drawing`, { credentials: 'same-origin' });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'drawing.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  async downloadPart(partId, fileName) {
    const res = await send(`/parts/${partId}/download`, { credentials: 'same-origin' });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || `part-${partId}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  /**
   * Open one of the admin PDFs (/api/pdf/...) in a new tab. The tab is opened
   * first, inside the click, so the browser does not treat it as a pop-up.
   */
  async openPdf(path) {
    const tab = window.open('', '_blank');
    try {
      const res = await send(`/pdf/${path}`, { credentials: 'same-origin' });
      const url = URL.createObjectURL(await res.blob());
      if (tab) tab.location = url; else window.location.assign(url);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      if (tab) tab.close();
      throw err;
    }
  },

  async updateOrderStatus(id, data) {
    return request(`/orders/${id}/status`, { method: 'PUT', body: JSON.stringify(data) });
  },
  /** Clear the "needs attention" flag on an order, with a note saying what was done. */
  async resolveOrderAttention(id, note) {
    return request(`/orders/${id}/resolve-attention`, { method: 'POST', body: JSON.stringify({ note }) });
  },
  /** What is switched on for payments, and how many orders are waiting for the owner. */
  async getPaymentSettings() { return request('/orders/admin/payment-settings'); },
  async createOrder(quoteId, shippingFields) {
    return request('/orders', { method: 'POST', body: JSON.stringify({ quoteId, ...shippingFields }) });
  },

  // RFQ (firm quotes)
  // `guard`: the form-token and bot-check headers from useFormGuard.
  async submitRfq(fields, drawingFile, guard = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.append(k, v);
    if (drawingFile) form.append('drawing', drawingFile);
    return postForm('/rfq', form, guard);
  },
  async getRfq(id) { return request(`/rfq/${id}`); },
  async getAdminRfqs() { return request('/rfq/admin/list'); },
  async updateRfq(id, data) { return request(`/rfq/admin/${id}`, { method: 'PUT', body: JSON.stringify(data) }); },
  /** Admin: delete a request and its attachment (refused once the request has become an order). */
  async deleteRequest(id) { return request(`/admin/requests/${id}`, { method: 'DELETE' }); },
  /** Admin: delete draft quotes of visitors without an account that nobody has touched for this many hours. */
  async purgeDrafts(olderThanHours = 48) { return request('/admin/drafts/purge', { method: 'POST', body: JSON.stringify({ olderThanHours }) }); },
  /** Admin: where the database and the file folders stand against their ceilings. */
  async getAdminStorage() { return request('/admin/storage'); },
  rfqDrawingUrl(id) { return `${BASE}/rfq/admin/${id}/drawing`; },
  async fetchRfqDrawing(id) {
    const res = await send(`/rfq/admin/${id}/drawing`, { credentials: 'same-origin' }, 'admin');
    return res.blob();
  },

  // Firm quote behind an emailed link (no account needed)
  async getFirmQuote(token) { return request(`/rfq/quote/${token}`); },
  async acceptFirmQuote(token, data) { return request(`/rfq/quote/${token}/accept`, { method: 'POST', body: JSON.stringify(data) }); },
  async confirmFirmQuotePayment(token) { return request(`/rfq/quote/${token}/confirm-payment`, { method: 'POST', body: '{}' }); },
  /** Back from the card page: ask where the order stands, with the return token from the address bar. */
  async confirmFirmQuoteReturn(order, token) { return request('/rfq/return/confirm', { method: 'POST', body: JSON.stringify({ order, token }) }); },

  // Stripe Checkout
  /**
   * `confirmedTotal` is the total the page is showing: if it is not what the server would charge,
   * the server answers `quote-changed` with the quote at today's price instead of charging.
   */
  async createCheckoutSession(quoteId, shippingFields, confirmedTotal) {
    return request('/orders/checkout-session', {
      method: 'POST',
      body: JSON.stringify({ quoteId, ...shippingFields, ...(Number.isFinite(confirmedTotal) ? { confirmedTotal } : {}) }),
    });
  },
};
