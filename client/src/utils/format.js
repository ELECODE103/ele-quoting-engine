export function formatCurrency(val) {
  const n = Number(val || 0);
  const sign = n < 0 ? '-' : '';
  return sign + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDim(mm) {
  const inches = mm / 25.4;
  if (inches < 0.1) return `${mm.toFixed(2)} mm`;
  return `${inches.toFixed(2)}"`;
}

// "11.81 × 7.87 × 0.50 in (300 × 200 × 12.7 mm)" — shop talks inches, CAD is usually mm.
export function formatBox(w, h, d) {
  const dims = [w, h, d].map((v) => Number(v) || 0);
  const inch = dims.map((v) => (v / 25.4).toFixed(2)).join(' × ');
  const mm = dims.map((v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1))).join(' × ');
  return `${inch} in (${mm} mm)`;
}

export function formatArea(mm2) {
  const in2 = mm2 / 645.16;
  return `${in2.toFixed(1)} in²`;
}

export function formatWeight(kg) {
  if (kg < 1) return `${(kg * 1000).toFixed(0)}g`;
  return `${kg.toFixed(2)} kg`;
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function classNames(...args) {
  return args.filter(Boolean).join(' ');
}
