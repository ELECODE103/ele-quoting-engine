/**
 * A field no person sees or reaches: off-screen, out of the tab order, hidden
 * from screen readers, and marked so browsers and password managers leave it
 * alone. A script that fills in every input fills this one, and the server
 * drops the submission. Static markup, so it prerenders and hydrates as is.
 */
export default function Honeypot({ value, onChange, name = 'website' }) {
  return (
    <div className="hp-field" aria-hidden="true">
      <label>
        Leave this field empty
        <input
          type="text"
          name={name}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          tabIndex={-1}
          autoComplete="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-form-type="other"
        />
      </label>
    </div>
  );
}
