#!/usr/bin/env node
/*
 * Wildcat Watch — data validator.
 *
 * Run this against the page BEFORE publishing. Any row that fails a check is
 * not trustworthy enough to show as a number; it should be quarantined and
 * rendered as "not verified" instead.
 *
 *   node validate.js public/arizona/basketball/index.html
 *
 * Exit code 1 means something failed. Wire that into the refresh so a bad
 * pull cannot silently reach the page.
 */

const fs = require("fs");

const file = process.argv[2] || "public/arizona/basketball/index.html";
const html = fs.readFileSync(file, "utf8");

// Pull the data array out of the page and evaluate just that part.
const script = html.split("<script>")[1].split("</script>")[0];
const dataOnly = script.split("var uid = 0;")[0];
global.esc = (s) => String(s);
eval(dataOnly);

const problems = [];
const warnings = [];
const fail = (who, what) => problems.push({ who, what });
const warn = (who, what) => warnings.push({ who, what });

const num = (v) => {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const boxVal = (p, label) => {
  const hit = (p.box || []).find((b) => b[1] === label);
  return hit ? num(hit[0]) : null;
};

for (const p of P) {
  // ---- 1. Every player needs a group, a club and an Arizona tenure.
  if (!["nba", "gl", "intl"].includes(p.g)) fail(p.n, `unknown group "${p.g}"`);
  if (!p.club) fail(p.n, "no club");
  if (!p.ua) fail(p.n, "no Arizona tenure recorded");

  // ---- 2. Eligibility: Arizona must be the last college he played for.
  // "then X" after the Arizona span means he transferred away to finish elsewhere.
  // "San Diego State, then Arizona 2023-24" is a transfer IN — he finished at Arizona.
  const transferredOut = /Arizona \d{4}[–-]\d{2,4}[^,]*,?\s*(·[^·]*)?\s*then [A-Z]/.test(p.ua);
  if (transferredOut) {
    fail(p.n, `fails the roster rule: transferred away from Arizona and finished his college career elsewhere (${p.ua})`);
  }

  // ---- 3. A game log must reconcile with the season averages beside it.
  if (p.log && p.log.length) {
    const played = p.log.filter((r) => !(r[2] === 0 && r[3] === null));
    if (!played.length) {
      fail(p.n, "has a game log with no games actually played");
      continue;
    }

    const gp = p.boxLabel ? null : boxVal(p, "GP");
    if (gp !== null && gp !== played.length) {
      // Known and accepted: a chart that covers only one of two competitions.
      if (p.chartNote) warn(p.n, `log has ${played.length} games, box says ${gp} GP (chart is scoped, noted on page)`);
      else fail(p.n, `log has ${played.length} games but box reports ${gp} GP`);
    }

    for (const [col, label] of [[3, "PTS"], [4, "REB"], [5, "AST"], [2, "MIN"]]) {
      const vals = played.map((r) => r[col]).filter((v) => v !== null);
      if (!vals.length) continue;
      const mine = vals.reduce((a, b) => a + b, 0) / vals.length;
      const pub = boxVal(p, label);
      if (pub === null) continue;
      const drift = Math.abs(mine - pub);
      // Minutes are logged as whole numbers, so allow a little slack there.
      const tol = label === "MIN" ? 0.45 : 0.16;
      if (drift > tol) {
        const msg = `${label}: log averages ${mine.toFixed(1)}, page shows ${pub}`;
        if (p.chartNote) warn(p.n, msg + " (scoped chart, noted on page)");
        else fail(p.n, msg);
      }
    }

    // A log row must be internally coherent: minutes but no stats is suspect.
    p.log.forEach((r) => {
      if (r[2] > 0 && r[3] === null) fail(p.n, `${r[0]}: ${r[2]} minutes logged but no points recorded`);
      if (r[2] === 0 && r[3] !== null && r[3] > 0) fail(p.n, `${r[0]}: scored ${r[3]} in zero minutes`);
    });
  }

  // ---- 4. Career table shape.
  if (p.c && p.c.length) {
    p.c.forEach((r, i) => {
      if (r.length !== 11) fail(p.n, `career row ${i + 1} has ${r.length} columns, expected 11`);
      if (!r[0]) fail(p.n, `career row ${i + 1} has no season`);
      if (!r[2]) fail(p.n, `career row ${i + 1} has no league — an unlabelled league is how a preseason or youth row sneaks in`);
    });

    // The current season should appear once per competition, not twice for one.
    const now = p.c.filter((r) => String(r[0]).startsWith("2026-27"));
    const seen = new Set();
    now.forEach((r) => {
      const key = r[1] + "|" + r[2];
      if (seen.has(key)) fail(p.n, `duplicate 2026-27 row for ${r[1]} (${r[2]})`);
      seen.add(key);
    });

    // If the page shows season averages, the current-season career row should match.
    const pts = boxVal(p, "PTS");
    const mainRow = now.find((r) => num(r[5]) !== null);
    // boxLabel means the headline figures are explicitly from another season.
    if (pts !== null && mainRow && !p.boxLabel) {
      const rowPts = num(mainRow[5]);
      if (rowPts !== null && Math.abs(rowPts - pts) > 0.16 && !p.chartNote) {
        fail(p.n, `box shows ${pts} PTS but the 2026-27 career row says ${rowPts}`);
      }
    }
  }

  // ---- 5. A player shown with numbers must have a verified club.
  const unverified = p.flag && /unconfirmed/i.test(p.flag[1]);
  if (unverified && p.box && p.box.length) {
    fail(p.n, "flagged unconfirmed but still displaying season averages — quarantine the numbers or verify the club");
  }

  // ---- 6. Written prose must not outrun the sample it rests on.
  if (p.note) {
    const gp = boxVal(p, "GP");
    const trendWords = /\b(dipped|declined|improved|trending|breakout|surging|collapsed|turnaround)\b/i;
    if (gp !== null && gp < 10 && trendWords.test(p.note)) {
      warn(p.n, `note claims a trend on ${gp} games — say the sample in the sentence or drop the claim`);
    }
    const retracted = [
      "eight straight", "22 for 22", "156 EuroLeague", "traded to New York",
      "fractures", "four NBA seasons", "Canadian summer league", "only non-college"
    ];
    retracted.forEach((r) => {
      if (p.note.includes(r)) fail(p.n, `note contains a claim that was audited and retracted: "${r}"`);
    });
  }
}

// ---- 7. Board rows must resolve to a real player and match his log.
const flatBoard = [];
(typeof RECENT !== "undefined" ? RECENT : []).forEach((grp) => {
  (grp.rows || []).forEach((r) => flatBoard.push(r));
});
flatBoard.forEach((r) => {
  const p = P.find((x) => x.n === r[0]);
  if (!p) { fail(r[0], "appears on the recent-games board but is not in the roster"); return; }
  if (!p.log) return;
  const day = r[1].replace(/^[A-Za-z]+ /, "");
  const row = p.log.find((l) => l[0].replace(/^[A-Za-z]+ /, "") === day);
  if (!row) { warn(p.n, `board shows a game on ${r[1]} that is not in his log`); return; }
  const m = /(\d+)\s*pts/.exec(r[3]);
  if (m && row[3] !== null && parseInt(m[1], 10) !== row[3]) {
    fail(p.n, `board says ${m[1]} pts on ${r[1]}, log says ${row[3]}`);
  }
});

// ---- report
const counts = P.reduce((a, p) => ((a[p.g] = (a[p.g] || 0) + 1), a), {});
console.log(`Wildcat Watch — validating ${P.length} players (${JSON.stringify(counts)})`);
console.log(`Game logs: ${P.filter((p) => p.log).length}  ·  Board rows: ${flatBoard.length}\n`);

if (warnings.length) {
  console.log(`WARNINGS (${warnings.length}) — shippable, but look at them:`);
  warnings.forEach((w) => console.log(`  ~ ${w.who}: ${w.what}`));
  console.log("");
}
if (problems.length) {
  console.log(`FAILURES (${problems.length}) — quarantine these rows, do not publish the numbers:`);
  problems.forEach((p) => console.log(`  x ${p.who}: ${p.what}`));
  process.exit(1);
}
console.log("All checks passed.");
