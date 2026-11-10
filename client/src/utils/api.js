/**
 * API client — all backend communication goes through here.
 */
const BASE = '/api';

let authToken = null;

export function setAuthToken(token) {
  authToken = token;
}

export function getAuthToken() {
  return authToken;
}

async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const res = await fetch(url, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw Object.assign(new Error(err.error || `Request failed: ${res.status}`), { status: res.status, code: err.code });
  }
  return res.json();
}

export const api = {
  // File upload
  // `process` (optional) lets the server refuse a DXF for anything but routing.
  async uploadFiles(files, process) {
    const form = new FormData();
    if (process) form.append('process', process); // before the files
    for (const f of files) form.append('files', f);
    const res = await fetch(`${BASE}/upload`, { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Upload failed');
    }
    return res.json();
  },

  // DXF only: confirm or change the drawing units ("mm" | "in"); returns the re-read part.
  async setPartUnits(partId, units) {
    return request(`/parts/${partId}/units`, { method: 'POST', body: JSON.stringify({ units }) });
  },

  // Quote
  /** Price the parts. `extra.quoteId` names the session's quote so it is updated, not re-created. */
  async getQuote(parts, leadTimeSlug = 'standard', extra = {}) {
    return request('/quote', {
      method: 'POST',
      body: JSON.stringify({ parts, leadTimeSlug, ...extra }),
    });
  },

  /** Parts + configuration of a saved quote, to reopen it in the builder. */
  async getQuoteSession(id) { return request(`/quote/${id}/session`); },

  async uploadQuoteDrawing(quoteId, file) {
    const form = new FormData();
    form.append('drawing', file);
    const headers = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(`${BASE}/quote/${quoteId}/drawing`, { method: 'POST', body: form, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Could not attach the drawing');
    }
    return res.json();
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
  async getAdminStats() { return request('/admin/stats'); },
  async getAdminParts() { return request('/admin/parts'); },

  // Auth
  async login(email, password) {
    return request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
  },
  async register(name, email, password, company = '') {
    return request('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password, company }) });
  },

  // Orders
  async getOrders() { return request('/orders'); },
  async getOrderById(id) { return request(`/orders/${id}`); },
  /** Ask the server to check with Stripe whether a just-placed order has been paid. */
  async confirmOrderPayment(id) { return request(`/orders/${id}/confirm-payment`, { method: 'POST', body: '{}' }); },
  /** Re-quote an order's parts at today's prices; returns { quoteId } for the builder. */
  async reorder(id) { return request(`/orders/${id}/reorder`, { method: 'POST', body: '{}' }); },
  async downloadOrderDrawing(id, fileName) {
    const headers = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(`${BASE}/orders/${id}/drawing`, { headers });
    if (!res.ok) throw new Error('Could not download the drawing');
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
    const headers = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(`${BASE}/parts/${partId}/download`, { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Download failed: ${res.status}`);
    }
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

  async updateOrderStatus(id, data) {
    return request(`/orders/${id}/status`, { method: 'PUT', body: JSON.stringify(data) });
  },
  async createOrder(quoteId, shippingFields) {
    return request('/orders', { method: 'POST', body: JSON.stringify({ quoteId, ...shippingFields }) });
  },

  // RFQ (firm quotes)
  async submitRfq(fields, drawingFile) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.append(k, v);
    if (drawingFile) form.append('drawing', drawingFile);
    const headers = {};
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const res = await fetch(`${BASE}/rfq`, { method: 'POST', body: form, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Could not submit request');
    }
    return res.json();
  },
  async getRfq(id) { return request(`/rfq/${id}`); },
  async getAdminRfqs() { return request('/rfq/admin/list'); },
  async updateRfq(id, data) { return request(`/rfq/admin/${id}`, { method: 'PUT', body: JSON.stringify(data) }); },
  rfqDrawingUrl(id) { return `${BASE}/rfq/admin/${id}/drawing`; },

  // Firm quote behind an emailed link (no account needed)
  async getFirmQuote(token) { return request(`/rfq/quote/${token}`); },
  async acceptFirmQuote(token, data) { return request(`/rfq/quote/${token}/accept`, { method: 'POST', body: JSON.stringify(data) }); },
  async confirmFirmQuotePayment(token) { return request(`/rfq/quote/${token}/confirm-payment`, { method: 'POST', body: '{}' }); },

  // Stripe Checkout
  async createCheckoutSession(quoteId, shippingFields) {
    return request('/orders/checkout-session', {
      method: 'POST',
      body: JSON.stringify({ quoteId, ...shippingFields }),
    });
  },
};
