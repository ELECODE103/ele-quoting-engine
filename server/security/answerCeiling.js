/**
 * A hard ceiling on the size of any JSON answer the API builds.
 *
 * Why: an answer is built and written on the one thread that serves every
 * visitor. A route that is handed more than it expected (a quote whose lines
 * all name one dense part, a list that has grown) used to build whatever size
 * that came to — the quote-session answer reached 478 MB and took the site
 * down. Every route is now bounded by construction (meshes are served from
 * their own streamed route, lists are capped), and this is the backstop for
 * the day one of them is not: past JSON_ANSWER_MAX_MB the answer is not sent,
 * the request gets a short refusal, and the log names the route.
 *
 * The answer is serialised once here (res.json would have done the same) and
 * measured before a byte goes out. Downloads that are files by design (the
 * admin's JSON backup) say so with `res.locals.skipAnswerCeiling = true`.
 */
const { limits } = require("./limits");
const brand = require("../../shared/brand.json");

const TOO_LARGE = {
  error: `That is more than we can show in one page. Reload the page; if it happens again, email ${brand.email} or call ${brand.phone} and we'll sort it out by hand.`,
  code: "answer-too-large",
};

const counters = { refused: 0, largestBytes: 0 };

function install(app) {
  app.use("/api", (req, res, next) => {
    const send = res.send.bind(res);
    res.json = (body) => {
      // An answer has already gone out for this request (an upload that was cut off while it was
      // still arriving is answered at that moment; the upload handler finishes later). A second
      // answer is dropped here rather than thrown from a callback, where it would stop the process.
      if (res.headersSent) return res;
      let text;
      try {
        text = JSON.stringify(body);
      } catch (err) {
        console.error(`Answer could not be serialised (${req.method} ${req.baseUrl || ""}${req.route ? req.route.path : req.path}): ${err.message}`);
        if (!res.statusCode || res.statusCode < 400) res.status(500);
        text = JSON.stringify({ error: "Something went wrong on our side. Try again in a minute." });
      }
      if (text === undefined) text = "null";
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > counters.largestBytes) counters.largestBytes = bytes;
      const max = limits.jsonAnswerMaxBytes;
      if (bytes > max && !res.locals.skipAnswerCeiling) {
        counters.refused++;
        console.error(`ANSWER TOO LARGE: ${req.method} ${req.baseUrl || ""}${req.route ? req.route.path : req.path} built ${(bytes / 1048576).toFixed(1)} MB of JSON, over the ${(max / 1048576).toFixed(0)} MB ceiling (JSON_ANSWER_MAX_MB). It was not sent.`);
        res.status(500);
        text = JSON.stringify(TOO_LARGE);
      }
      if (!res.get("Content-Type")) res.set("Content-Type", "application/json; charset=utf-8");
      return send(text);
    };
    next();
  });
}

module.exports = { install, counters, TOO_LARGE };
