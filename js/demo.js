// Sample data so the map, stats and insights can be explored before logging
// real rounds. Everything created here is flagged demo:true and can be removed
// in Settings without touching real data.
import { addDemoData } from './store.js';
import { lastNearbyResult } from './geo.js';
import { isoDate, addDays } from './utils.js';

const FAMOUS = [
  { id: 'demo:harding', name: 'TPC Harding Park', lat: 37.7243, lng: -122.4933, city: 'San Francisco', region: 'CA', par: 72, rating: 72.8, slope: 130, diff: 0, home: true },
  { id: 'demo:pebble', name: 'Pebble Beach Golf Links', lat: 36.5686, lng: -121.9496, city: 'Pebble Beach', region: 'CA', par: 72, rating: 73.1, slope: 139, diff: 4 },
  { id: 'demo:torrey', name: 'Torrey Pines (South)', lat: 32.8996, lng: -117.2517, city: 'La Jolla', region: 'CA', par: 72, rating: 74.0, slope: 136, diff: 3 },
  { id: 'demo:bandon', name: 'Bandon Dunes', lat: 43.1875, lng: -124.3937, city: 'Bandon', region: 'OR', par: 72, rating: 72.1, slope: 131, diff: 1 },
  { id: 'demo:chambers', name: 'Chambers Bay', lat: 47.2019, lng: -122.5744, city: 'University Place', region: 'WA', par: 72, rating: 72.6, slope: 133, diff: 2 },
  { id: 'demo:bethpage', name: 'Bethpage Black', lat: 40.7447, lng: -73.4540, city: 'Farmingdale', region: 'NY', par: 71, rating: 75.4, slope: 148, diff: 7 },
  { id: 'demo:pinehurst', name: 'Pinehurst No. 2', lat: 35.1910, lng: -79.4686, city: 'Pinehurst', region: 'NC', par: 72, rating: 73.8, slope: 138, diff: 4 },
];

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTES = ['', '', '', 'Windy back nine', 'Played with the Saturday group', 'New driver felt great', 'Three-putted too often', 'Early tee time, cold start', 'Best ball-striking in months', ''];

export function buildSampleData() {
  const near = lastNearbyResult().courses || [];
  // Prefer real courses around the user when we already know them.
  const courses = near.length >= 3
    ? near.slice(0, 5).map((c, i) => ({ ...c, id: `demo:${c.id}`, par: c.par || 72, rating: 71.4 + i * 0.6, slope: 126 + i * 3, diff: [0, 2, 4, 1, 3][i], home: i === 0 }))
    : FAMOUS;
  const rnd = mulberry32(1847);
  const noise = () => (rnd() + rnd() + rnd() - 1.5) * 4.2;
  const rounds = [];
  const start = addDays(new Date(), -470);
  let day = 0, i = 0;
  while (day < 465) {
    const date = addDays(start, day);
    const progress = day / 465;
    const course = rnd() < 0.5 ? courses.find((c) => c.home) || courses[0] : courses[1 + Math.floor(rnd() * (courses.length - 1))];
    const nine = i % 11 === 5;
    const skill = 94 - progress * 8.5 + course.diff + noise();
    const score = Math.round(nine ? skill / 2 + 0.5 : skill);
    rounds.push({
      id: `demo-r${i}`,
      courseId: course.id,
      date: isoDate(date),
      score,
      holes: nine ? 9 : 18,
      par: nine ? 36 : course.par,
      tees: rnd() < 0.7 ? 'White' : 'Blue',
      rating: nine ? null : course.rating,
      slope: nine ? null : course.slope,
      notes: NOTES[Math.floor(rnd() * NOTES.length)],
      source: i % 7 === 3 ? 'scan' : 'manual',
    });
    day += 9 + Math.floor(rnd() * 18);
    i++;
  }
  return {
    courses: courses.map(({ diff, home, rating, slope, distanceKm, ...c }) => ({ ...c, source: 'demo' })),
    rounds,
  };
}

export function loadSampleData() {
  const data = buildSampleData();
  addDemoData(data);
  return data;
}
