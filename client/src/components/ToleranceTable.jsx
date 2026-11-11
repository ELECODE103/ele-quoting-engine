import { toleranceRows, when } from '../facts';

/**
 * Tolerance by material. Rows come from shared/shop-facts.json (`tol-*`) and
 * only confirmed rows render; with none confirmed the table renders nothing.
 */
export default function ToleranceTable() {
  const rows = toleranceRows();
  if (rows.length === 0) return null;
  const anyTight = rows.some((r) => r.tight);
  return (
    <>
      <div className="card" style={{ overflowX: 'auto' }}>
        <table className="prop-table">
          <thead>
            <tr>
              <th scope="col">Material</th>
              <th scope="col">Standard</th>
              {anyTight && <th scope="col">Tightest quoted</th>}
              <th scope="col">What moves it</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.material}</th>
                <td>{r.standard}</td>
                {anyTight && <td>{r.tight || 'Ask'}</td>}
                <td>{r.moves}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fineprint">
        {when('practice-rest', 'Measured at room temperature after the parts have sat. ')}
        Plastic expands five to ten times as much as steel for the same temperature change, so tell us where the part lives.
        A plastic not listed here is quoted with its tolerance stated before you order.
      </p>
    </>
  );
}
