const c = require("/home/claude/ele-quoting-engine/.claude/worktrees/sec-review/tools/security/review/lib/common.js");
(async () => {
  const s = await c.start();
  try {
    const ip = "203.0.113.5";
    const up = await s.upload([{ name: "block.stl", data: c.boxStl([100, 80, 40]) }], { ip });
    const partId = up.body.parts[0].partId;
    const q = async (cfg, extra = {}) => {
      const r = await s.post("/api/quote", { parts: [{ partId, ...cfg }], leadTimeSlug: "standard", ...extra }, { ip: c.randomIp() });
      return r.status === 200 ? `total=${r.body.orderTotal} sub=${r.body.subtotal} unit=${r.body.lineItems[0].perUnit.final} rfq=${r.body.gate.requiresRfq} ${r.body.gate.reasons.map(x=>x.code)}` : `${r.status} ${JSON.stringify(r.body)}`;
    };
    console.log("baseline cnc delrin      ", await q({ materialSlug: "cnc-delrin", process: "cnc", quantity: 1 }));
    console.log("peek cnc                 ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: 1 }));
    console.log("peek as 3d-printing      ", await q({ materialSlug: "cnc-peek", process: "3d-printing", quantity: 1 }));
    console.log("peek as routing          ", await q({ materialSlug: "cnc-peek", process: "routing", quantity: 1 }));
    console.log("peek as routing t=0.01   ", await q({ materialSlug: "cnc-peek", process: "routing", quantity: 1, thicknessMm: 0.01 }));
    console.log("peek as sheetmetal       ", await q({ materialSlug: "cnc-peek", process: "sheetmetal", quantity: 1 }));
    console.log("peek as sheetmetal t=.001", await q({ materialSlug: "cnc-peek", process: "sheetmetal", quantity: 1, thicknessMm: 0.001 }));
    console.log("peek process bogus       ", await q({ materialSlug: "cnc-peek", process: "nonsense", quantity: 1 }));
    console.log("peek process __proto__   ", await q({ materialSlug: "cnc-peek", process: "__proto__", quantity: 1 }));
    console.log("peek process constructor ", await q({ materialSlug: "cnc-peek", process: "constructor", quantity: 1 }));
    console.log("fdm-pla as cnc           ", await q({ materialSlug: "fdm-pla", process: "cnc", quantity: 1 }));
    console.log("fdm-pla 3dp              ", await q({ materialSlug: "fdm-pla", process: "3d-printing", quantity: 1 }));
    console.log("fdm-pla 3dp infill -1000 ", await q({ materialSlug: "fdm-pla", process: "3d-printing", quantity: 1, infill: -1000 }));
    console.log("fdm-pla 3dp infill 1e9   ", await q({ materialSlug: "fdm-pla", process: "3d-printing", quantity: 1, infill: 1e9 }));
    console.log("fdm-pla 3dp sub bogus    ", await q({ materialSlug: "fdm-pla", process: "3d-printing", subProcess: "sla", quantity: 1 }));
    console.log("peek cnc sub turning     ", await q({ materialSlug: "cnc-peek", process: "cnc", subProcess: "turning", quantity: 1 }));
    console.log("peek cnc grade bogus     ", await q({ materialSlug: "cnc-peek", process: "cnc", grade: "zzz", quantity: 1 }));
    console.log("qty 0                    ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: 0 }));
    console.log("qty -5                   ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: -5 }));
    console.log("qty 0.5                  ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: 0.5 }));
    console.log("qty 100                  ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: 100 }));
    console.log("qty 1e6                  ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: 1e6 }));
    console.log("qty 1e300                ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: 1e300 }));
    console.log("qty '1e2'                ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: "1e2" }));
    console.log("thickness -5             ", await q({ materialSlug: "cnc-peek", process: "cnc", thicknessMm: -5, quantity: 1 }));
    console.log("finish bogus             ", await q({ materialSlug: "cnc-peek", process: "cnc", finishSlug: "nope", quantity: 1 }));
    console.log("finish sheetmetal raw    ", await q({ materialSlug: "cnc-peek", process: "cnc", finishSlug: "raw", quantity: 1 }));
    console.log("lead bogus               ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: 1 }, { leadTimeSlug: "rush" }));
    console.log("lead same-day            ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: 1 }, { leadTimeSlug: "same-day" }));
    console.log("paperwork amount         ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: 1 }, { paperwork: true, paperworkFee: -500, orderTotal: 1, subtotal: 1 }));
    console.log("mass assign              ", await q({ materialSlug: "cnc-peek", process: "cnc", quantity: 1, lineTotal: 0.01, perUnit: { final: 0.01 } }, { status: "ordered", userId: "x", gate: { requiresRfq: false }, expiresAt: "2099-01-01", orderTotal: 0.5 }));
  } finally { await s.stop(); }
})().catch((e) => { console.error(e); process.exit(1); });
