import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import PublicLayout from '../components/PublicLayout';
import { api } from '../utils/api';
import { formatCurrency, formatShipDate, orderStatusLabel } from '../utils/format';
import brand from '../brand';

// Set by the firm-quote page just before it sends the buyer to the card page, in this tab only.
export const QUOTE_LINK_KEY = 'se_firm_quote_link';

/**
 * Where the card page sends a firm-quote buyer afterwards. The address holds the order and a
 * short-lived return token, never the quote link (that link is the buyer's key, and the card
 * processor sees this address). If this tab still remembers the quote link, the buyer goes
 * straight back to their quote page. If it does not (another browser, a new tab), this page
 * says where the order stands and points them to the link in their email.
 */
export default function FirmQuoteReturnPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const order = params.get('o') || '';
  const token = params.get('r') || '';
  const cancelled = params.get('cancelled') === 'true';
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let link = '';
    try { link = window.sessionStorage.getItem(QUOTE_LINK_KEY) || ''; } catch { /* storage switched off: stay on this page */ }
    let stop = false;
    (async () => {
      let result = null;
      if (!cancelled && order && token) {
        // The card processor's confirmation can trail the redirect by a few seconds.
        for (let attempt = 0; attempt < 4 && !stop; attempt++) {
          result = await api.confirmFirmQuoteReturn(order, token).catch(() => null);
          if (!result || result.status !== 'pending_payment' || result.paymentUnderReview) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (stop) return;
      if (link) { navigate(`/firm-quote/${link}?${cancelled ? 'cancelled' : 'paid'}=true`, { replace: true }); return; }
      setState({ loading: false, result });
    })();
    return () => { stop = true; };
  }, [order, token, cancelled, navigate]);

  const r = state.result;
  const paid = r && !['pending_payment', 'expired', 'cancelled'].includes(r.status);

  return (
    <PublicLayout title="Your firm quote">
      <section className="section">
        <div className="pub-wrap" style={{ maxWidth: 680 }}>
          <div className="eyebrow" style={{ marginBottom: 14 }}>Firm quote{r ? ` · order ${r.reference}` : ''}</div>
          {state.loading ? (
            <div style={{ textAlign: 'center' }}><div className="spinner" style={{ margin: '0 auto' }} role="status" aria-label="Checking your payment" /></div>
          ) : cancelled ? (
            <>
              <h1 className="display" style={{ marginBottom: 16 }}>The card payment was cancelled.</h1>
              <p className="lede" role="status">Nothing was charged. Open the link in your quote email to pay, or to give us a purchase order number.</p>
            </>
          ) : paid ? (
            <>
              <h1 className="display" style={{ marginBottom: 16 }}>Payment received. Thank you.</h1>
              <p className="lede" role="status">
                Order {r.reference}, {formatCurrency(r.total)}: {orderStatusLabel(r.status).toLowerCase()}.
                {r.shipBy ? ` Your parts ship by ${formatShipDate(r.shipBy, { year: true })}.` : ''} A confirmation is on its way to your email. The link in it is your order page.
              </p>
            </>
          ) : r && r.paymentUnderReview ? (
            <>
              <h1 className="display" style={{ marginBottom: 16 }}>We're checking your payment.</h1>
              <p className="lede" role="status">We received a payment for order {r.reference} and need to look at it before we confirm the order. We'll email you today. Questions: {brand.phone}.</p>
            </>
          ) : r ? (
            <>
              <h1 className="display" style={{ marginBottom: 16 }}>We're waiting for the payment to come through.</h1>
              <p className="lede" role="status">The card processor hasn't confirmed the payment for order {r.reference} yet. You'll get an email as soon as it does. If none arrives in a few minutes, open the link in your quote email or call {brand.phone}.</p>
            </>
          ) : (
            <>
              <h1 className="display" style={{ marginBottom: 16 }}>Open your quote from the email.</h1>
              <p className="lede" role="status">This page can't show your order any more. If you paid, a confirmation email is on its way. The link in your quote email opens your order page.</p>
            </>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 24 }}>
            <a className="btn btn-ghost" href={`mailto:${brand.email}`}>Email {brand.email}</a>
            <a className="btn btn-ghost" href={brand.phoneHref}>Call {brand.phone}</a>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
