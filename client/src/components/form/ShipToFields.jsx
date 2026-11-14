/**
 * The ship-to address block of the firm-quote request form and the firm-quote page
 * (review of 2026-11-13, N-05): name, street, city, state, ZIP code, country.
 *
 * `value` is { shippingName, shippingAddress, shippingCity, shippingState, shippingZip,
 * shippingCountry }, the names the server reads. For a United States address the state is chosen
 * from the list the server checks the ZIP code against (StateSelect); for another country it is
 * typed. Nothing here decides a price: a person prices freight to this address.
 */
import StateSelect from './StateSelect';

export const EMPTY_SHIP_TO = { shippingName: '', shippingAddress: '', shippingCity: '', shippingState: '', shippingZip: '', shippingCountry: 'US' };

/** Is every field a ship-to needs filled in? */
export function shipToComplete(v) {
  return ['shippingName', 'shippingAddress', 'shippingCity', 'shippingState', 'shippingZip'].every((k) => String((v && v[k]) || '').trim());
}

/** The address as one line, for "we priced this quote for …". */
export function shipToLine(v) {
  if (!v) return '';
  return [v.shippingName, v.shippingAddress, [v.shippingCity, [v.shippingState, v.shippingZip].filter(Boolean).join(' ')].filter(Boolean).join(', '), v.shippingCountry && v.shippingCountry !== 'US' ? v.shippingCountry : ''].filter(Boolean).join(', ');
}

export default function ShipToFields({ value, onChange, idPrefix = 'ship', nameLabel = 'Name / company', nameRequired = true, invalid = '', describedBy = '' }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e && e.target ? e.target.value : e });
  const us = (value.shippingCountry || 'US') === 'US';
  const bad = (k) => (invalid === k ? { 'aria-invalid': true, ...(describedBy ? { 'aria-describedby': describedBy } : {}) } : {});
  return (
    <>
      <label className="full"><span className="field-label">{nameLabel}</span><input id={`${idPrefix}-name`} className="input" value={value.shippingName} onChange={set('shippingName')} autoComplete="shipping name" required={nameRequired} {...bad('shippingName')} /></label>
      <label className="full"><span className="field-label">Street address</span><input id={`${idPrefix}-street`} className="input" value={value.shippingAddress} onChange={set('shippingAddress')} autoComplete="shipping address-line1" required {...bad('shippingAddress')} /></label>
      <label><span className="field-label">City</span><input id={`${idPrefix}-city`} className="input" value={value.shippingCity} onChange={set('shippingCity')} autoComplete="shipping address-level2" required {...bad('shippingCity')} /></label>
      <label>
        <span className="field-label">{us ? 'State' : 'State or province'}</span>
        {us
          ? <StateSelect id={`${idPrefix}-state`} value={value.shippingState} onChange={set('shippingState')} autoComplete="shipping address-level1" {...bad('shippingState')} />
          : <input id={`${idPrefix}-state`} className="input" value={value.shippingState} onChange={set('shippingState')} autoComplete="shipping address-level1" required {...bad('shippingState')} />}
      </label>
      <label><span className="field-label">{us ? 'ZIP code' : 'Postal code'}</span><input id={`${idPrefix}-zip`} className="input" value={value.shippingZip} onChange={set('shippingZip')} autoComplete="shipping postal-code" inputMode={us ? 'numeric' : 'text'} required {...bad('shippingZip')} /></label>
      <label>
        <span className="field-label">Country</span>
        <select id={`${idPrefix}-country`} className="input" value={value.shippingCountry || 'US'} onChange={set('shippingCountry')} autoComplete="shipping country">
          <option value="US">United States</option>
          <option value="CA">Canada</option>
          <option value="MX">Mexico</option>
        </select>
      </label>
    </>
  );
}
