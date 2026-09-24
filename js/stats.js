// Scoring analytics built on overall round totals only (no per-hole data).
import { avg, median, stdev, parseISO } from './utils.js';

export const toPar = (r) => (r.par ? r.score - r.par : null);
// To-par scaled to 18 holes so 9-hole rounds compare with 18-hole rounds.
export const toPar18 = (r) => (r.par ? (r.score - r.par) * (18 / r.holes) : null);

// World Handicap System score differential (gross score stands in for the
// adjusted gross score, since hole-by-hole net double bogey isn't tracked).
export function differential(r) {
  if (r.holes !== 18) return null;
  const rating = r.rating ?? r.par;
  if (rating == null) return null;
  const slope = r.slope ?? 113;
  return Math.round((113 / slope) * (r.score - rating) * 10) / 10;
}

// WHS table: rounds available -> [differentials used, adjustment]
const HCP_TABLE = {
  3: [1, -2], 4: [1, -1], 5: [1, 0], 6: [2, -1], 7: [2, 0], 8: [2, 0], 9: [3, 0], 10: [3, 0],
  11: [3, 0], 12: [4, 0], 13: [4, 0], 14: [4, 0], 15: [5, 0], 16: [5, 0], 17: [6, 0], 18: [6, 0], 19: [7, 0], 20: [8, 0],
};
export function handicapIndex(rounds, { asOf = null } = {}) {
  const eligible = rounds
    .filter((r) => r.holes === 18 && differential(r) != null && (!asOf || r.date <= asOf))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 20);
  const n = eligible.length;
  if (n < 3) return { value: null, count: n, needed: 3 - n };
  const [take, adj] = HCP_TABLE[n];
  const diffs = eligible.map(differential).sort((a, b) => a - b).slice(0, take);
  const value = Math.min(54, Math.round((avg(diffs) + adj) * 10) / 10);
  const approx = eligible.some((r) => r.rating == null || r.slope == null);
  return { value, count: n, used: take, approx };
}

export function summarize(rounds) {
  const r18 = rounds.filter((r) => r.holes === 18);
  const r9 = rounds.filter((r) => r.holes === 9);
  const chrono18 = [...r18].sort((a, b) => (a.date < b.date ? -1 : 1));
  const scores = r18.map((r) => r.score);
  const best18 = r18.reduce((b, r) => (!b || r.score < b.score ? r : b), null);
  const worst18 = r18.reduce((w, r) => (!w || r.score > w.score ? r : w), null);
  const best9 = r9.reduce((b, r) => (!b || r.score < b.score ? r : b), null);
  const last5 = chrono18.slice(-5).map((r) => r.score);
  const prev5 = chrono18.slice(-10, -5).map((r) => r.score);
  const toPars = rounds.map(toPar18).filter((v) => v != null);
  const breaks = { 100: 0, 90: 0, 80: 0, 70: 0 };
  for (const s of scores) for (const k of Object.keys(breaks)) if (s < +k) breaks[k]++;
  return {
    count: rounds.length,
    count18: r18.length,
    count9: r9.length,
    avg18: avg(scores),
    avg9: avg(r9.map((r) => r.score)),
    median18: median(scores),
    stdev18: stdev(scores),
    best18,
    worst18,
    best9,
    avgToPar18: avg(toPars),
    last5Avg: last5.length >= 3 ? avg(last5) : null,
    prev5Avg: prev5.length >= 3 ? avg(prev5) : null,
    breaks,
    courses: new Set(rounds.map((r) => r.courseId)).size,
    firstDate: rounds.length ? rounds.reduce((m, r) => (r.date < m ? r.date : m), rounds[0].date) : null,
    lastDate: rounds.length ? rounds.reduce((m, r) => (r.date > m ? r.date : m), rounds[0].date) : null,
  };
}

export function courseStats(rounds) {
  const sorted = [...rounds].sort((a, b) => (a.date < b.date ? 1 : -1));
  const primary = sorted.filter((r) => r.holes === 18).length ? sorted.filter((r) => r.holes === 18) : sorted;
  const scores = primary.map((r) => r.score);
  const best = primary.reduce((b, r) => (!b || r.score < b.score ? r : b), null);
  const toPars = sorted.map(toPar18).filter((v) => v != null);
  return {
    count: sorted.length,
    holes: primary[0]?.holes ?? 18,
    best,
    avg: avg(scores),
    last: sorted[0] || null,
    avgToPar18: avg(toPars),
    avgScore18: avg(sorted.filter((r) => r.holes === 18).map((r) => r.score)),
    trend: primary.slice(0, 12).reverse().map((r) => r.score),
  };
}

// Better / typical / tougher than the player's own average (in strokes vs par per 18).
export function performanceClass(courseAvgToPar, overallAvgToPar, courseAvgScore, overallAvgScore) {
  let diff = null;
  if (courseAvgToPar != null && overallAvgToPar != null) diff = courseAvgToPar - overallAvgToPar;
  else if (courseAvgScore != null && overallAvgScore != null) diff = courseAvgScore - overallAvgScore;
  if (diff == null) return 'typical';
  if (diff <= -1.5) return 'better';
  if (diff >= 1.5) return 'tougher';
  return 'typical';
}

export function histogram(scores, width = 5) {
  if (!scores.length) return [];
  const lo = Math.floor(Math.min(...scores) / width) * width;
  const hi = Math.floor(Math.max(...scores) / width) * width;
  const bins = [];
  for (let s = lo; s <= hi; s += width) bins.push({ from: s, to: s + width - 1, count: 0 });
  for (const s of scores) bins[Math.floor((s - lo) / width)].count++;
  return bins;
}

// Trailing moving average; starts once 3 values are available.
export function rollingAverage(values, window = 5) {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    return slice.length >= Math.min(3, values.length) ? avg(slice) : null;
  });
}

// Least-squares slope in strokes per 30 days.
export function trendPerMonth(rounds) {
  if (rounds.length < 4) return null;
  const pts = rounds.map((r) => [parseISO(r.date).getTime() / 86400000, r.score]);
  const mx = avg(pts.map((p) => p[0])), my = avg(pts.map((p) => p[1]));
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? (num / den) * 30 : null;
}

// Compact payload for Gemini insights: scores, dates and course names only
// (no player names, notes or coordinates are sent).
export function insightsPayload(rounds, courses, settingsUnits) {
  const chrono = [...rounds].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-60);
  const s = summarize(rounds);
  const hcp = handicapIndex(rounds);
  const perCourse = {};
  for (const r of rounds) {
    const name = courses[r.courseId]?.name || 'Unknown course';
    (perCourse[name] ||= []).push(r);
  }
  return {
    today: new Date().toISOString().slice(0, 10),
    units: settingsUnits,
    totals: {
      rounds: s.count, rounds18: s.count18, rounds9: s.count9,
      scoringAverage18: round1(s.avg18), best18: s.best18?.score ?? null, worst18: s.worst18?.score ?? null,
      standardDeviation18: round1(s.stdev18), averageToParPer18: round1(s.avgToPar18),
      last5Average18: round1(s.last5Avg), previous5Average18: round1(s.prev5Avg),
      strokesPerMonthTrend: round1(trendPerMonth(rounds.filter((r) => r.holes === 18))),
      handicapIndexEstimate: hcp.value, handicapRoundsUsed: hcp.count,
      roundsBreaking: { 100: s.breaks[100], 90: s.breaks[90], 80: s.breaks[80] },
    },
    courses: Object.entries(perCourse).map(([name, rs]) => {
      const cs = courseStats(rs);
      return { name, rounds: cs.count, average: round1(cs.avg), best: cs.best?.score ?? null, averageToParPer18: round1(cs.avgToPar18) };
    }).sort((a, b) => b.rounds - a.rounds).slice(0, 15),
    rounds: chrono.map((r) => ({
      date: r.date, course: courses[r.courseId]?.name || 'Unknown', holes: r.holes, score: r.score,
      par: r.par, toPar: toPar(r), rating: r.rating, slope: r.slope, differential: differential(r),
    })),
  };
}
const round1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
