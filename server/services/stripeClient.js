/**
 * The one place the Stripe SDK is constructed, so routes share a client and
 * tests can swap in a stub at the boundary (`setForTests`).
 */
let client;

function get() {
  if (client === undefined) {
    client = process.env.STRIPE_SECRET_KEY ? require("stripe")(process.env.STRIPE_SECRET_KEY) : null;
  }
  return client;
}

function setForTests(stub) {
  client = stub;
}

module.exports = { get, setForTests };
