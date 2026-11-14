/**
 * The state of a United States address, chosen from a list (review of 2026-11-13, N-03).
 *
 * It used to be a free-text box, and the server decided "is this inside the contiguous United
 * States" from what was typed there. The list is the one the server checks against
 * (shared/us-states.json): the 50 states and DC, then the territories and the military "states".
 * Alaska, Hawaii, the territories and military addresses are on it on purpose: a buyer there
 * picks the truth and is told how freight is priced, instead of having nothing to pick.
 *
 * The value is the two-letter code. A value that is not on the list (an older saved draft held
 * whatever was typed) shows as "Choose a state".
 */
import states from '../../../../shared/us-states.json';

const CODES = new Set(states.map((s) => s.code));

/** '' unless `value` is one of the codes on the list. */
export function knownState(value) {
  const v = String(value || '').trim().toUpperCase();
  return CODES.has(v) ? v : '';
}

export default function StateSelect({ value, onChange, id, className = 'input', autoComplete = 'address-level1', required = true, ...rest }) {
  return (
    <select id={id} className={className} value={knownState(value)} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} required={required} {...rest}>
      <option value="">Choose a state</option>
      {states.map((s) => <option key={s.code} value={s.code}>{s.code} · {s.name}</option>)}
    </select>
  );
}
