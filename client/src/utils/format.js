export function formatCurrency(val) {
  return '$' + Number(val || 0).toFixed(2);
}

export function formatDim(mm) {
  const inches = mm / 25.4;
  if (inches < 0.1) return `${mm.toFixed(2)}mm`;
  return `${inches.toFixed(3)}"`;
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

export function classNames(...args) {
  return args.filter(Boolean).join(' ');
}
