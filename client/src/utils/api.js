/**
 * API client — all backend communication goes through here.
 */
const BASE = '/api';

async function request(path, options = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  // File upload
  async uploadFiles(files) {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    const res = await fetch(`${BASE}/upload`, { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Upload failed');
    }
    return res.json();
  },

  // Quote
  async getQuote(parts, leadTimeSlug = 'standard') {
    return request('/quote', {
      method: 'POST',
      body: JSON.stringify({ parts, leadTimeSlug }),
    });
  },

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

  async getPricingRules() { return request('/admin/pricing'); },
  async updatePricingRules(data) {
    return request('/admin/pricing', { method: 'PUT', body: JSON.stringify(data) });
  },

  async getAdminLeadTimes() { return request('/admin/lead-times'); },
  async updateLeadTime(id, data) {
    return request(`/admin/lead-times/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  },

  async getAdminQuotes() { return request('/admin/quotes'); },
  async getAdminStats() { return request('/admin/stats'); },
};
