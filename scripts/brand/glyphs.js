// The custom straight-stroke alphabet from round 2 (direction F), lifted into its own module so
// round 3 can set it on the blade. Cap 100, stem 20, letter box 72 (I = 20); every curve is a
// 45° machined chamfer: 22 on the outside, 10.3 on the inside.
const { poly } = require('./geom3');
const r = (n) => Math.round(n * 100) / 100;
const S_ = 20, C_ = 22, CI = C_ - 0.586 * S_, W_ = 72;
const GLYPHS = {
  S: { w: W_, d: poly([[C_, 0], [W_ - C_, 0], [W_, C_], [W_, 29], [52, 29], [52, 20 + CI], [52 - CI, 20], [20 + CI, 20], [20, 20 + CI], [20, 40], [W_, 40], [W_, 100 - C_], [W_ - C_, 100], [C_, 100], [0, 100 - C_], [0, 71], [20, 71], [20, 80 - CI], [20 + CI, 80], [52 - CI, 80], [52, 80 - CI], [52, 60], [0, 60], [0, C_]]) },
  T: { w: W_, d: poly([[0, 0], [W_, 0], [W_, 20], [46, 20], [46, 100], [26, 100], [26, 20], [0, 20]]) },
  R: { w: W_, d: poly([[0, 0], [W_ - C_, 0], [W_, C_], [W_, 56 - C_], [W_ - C_, 56], [56, 56], [W_, 100], [52, 100], [36, 56], [20, 56], [20, 100], [0, 100]]) + poly([[20, 20], [52 - CI, 20], [52, 20 + CI], [52, 36 - CI], [52 - CI, 36], [20, 36]]) },
  A: { w: W_, d: poly([[C_, 0], [W_ - C_, 0], [W_, C_], [W_, 100], [52, 100], [52, 70], [20, 70], [20, 100], [0, 100], [0, C_]]) + poly([[20 + CI, 20], [52 - CI, 20], [52, 20 + CI], [52, 50], [20, 50], [20, 20 + CI]]) },
  I: { w: 20, d: poly([[0, 0], [20, 0], [20, 100], [0, 100]]) },
  G: { w: W_, d: poly([[C_, 0], [W_ - C_, 0], [W_, C_], [W_, 32], [52, 32], [52, 20 + CI], [52 - CI, 20], [20 + CI, 20], [20, 20 + CI], [20, 80 - CI], [20 + CI, 80], [52 - CI, 80], [52, 80 - CI], [52, 66], [38, 66], [38, 48], [W_, 48], [W_, 100 - C_], [W_ - C_, 100], [C_, 100], [0, 100 - C_], [0, C_]]) },
  H: { w: W_, d: poly([[0, 0], [20, 0], [20, 40], [52, 40], [52, 0], [W_, 0], [W_, 100], [52, 100], [52, 60], [20, 60], [20, 100], [0, 100]]) },
  E: { w: W_ - 6, d: poly([[0, 0], [66, 0], [66, 20], [20, 20], [20, 40], [60, 40], [60, 60], [20, 60], [20, 80], [66, 80], [66, 100], [0, 100]]) },
  D: { w: W_, d: poly([[0, 0], [W_ - C_, 0], [W_, C_], [W_, 100 - C_], [W_ - C_, 100], [0, 100]]) + poly([[20, 20], [52 - CI, 20], [52, 20 + CI], [52, 80 - CI], [52 - CI, 80], [20, 80]]) },
};
// y is the baseline; glyphs are drawn top-down from 0..100 so translate by y - cap
function customWord(str, cap, x, y, fill, gap = 14) {
  const k = cap / 100;
  let cx = 0; const parts = [];
  for (const ch of str) {
    const g = GLYPHS[ch];
    parts.push(`  <path transform="translate(${r(x + cx * k)} ${r(y - cap)}) scale(${r(k)})" fill="${fill}" fill-rule="evenodd" d="${g.d}"/>`);
    cx += g.w + gap;
  }
  return { markup: parts.join('\n'), width: (cx - gap) * k };
}
function customWidth(str, cap, gap = 14) { return customWord(str, cap, 0, 0, '#000', gap).width; }
module.exports = { GLYPHS, customWord, customWidth };
