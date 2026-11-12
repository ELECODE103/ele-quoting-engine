/**
 * The app's message catalogue: utils/messageCatalogue.js, given the brand
 * facts. Everything that shows a server refusal to a buyer gets its words
 * from here (api.js does it for every request, so pages read `err.message`).
 */
import brand from '../brand';
import { fact } from '../facts';
import { createCatalogue } from './messageCatalogue';

const catalogue = createCatalogue(brand, { quoteTurnaround: fact('quote-turnaround') || '' });

export const describeRefusal = catalogue.describe;
export const contextFor = catalogue.contextFor;
/** The sentence for an order state (payment under review, awaiting PO, refunded, partially refunded, disputed, expired, cancelled). */
export const describeOrderState = catalogue.orderState;
/** The sentence for one reason a quote goes to a person ({ code, message } from gate.reasons). */
export const describeGateReason = catalogue.gateReason;
/** A sentence that is not a refusal: something the server did that the buyer should know about (a confirmation email held in line). */
export const describeNotice = catalogue.notice;
export default catalogue;
