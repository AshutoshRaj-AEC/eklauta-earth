import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EXTRAPOLATION_S,
  SNAP_DISTANCE_M,
  angleDiffDeg,
  createFollowSmoother,
  lerpAngleDeg,
  pointAtDistance,
  smoothingAlpha,
} from './followSmoother.js';
import {
  cumulativeDistancesM,
  destinationPoint,
  haversineM,
  projectOntoRoute,
} from './routeProgress.js';
import { formatSpeedKmh, maneuverArrow } from './maneuvers.js';

// 2 km straight east, then 1 km north.
const START = { lat: 18.59, lon: 73.73 };
const CORNER = destinationPoint(START, 90, 2000);
const END = destinationPoint(CORNER, 0, 1000);
const GEOMETRY = [
  [START.lon, START.lat],
  [CORNER.lon, CORNER.lat],
  [END.lon, END.lat],
];
const ROUTE = { geometry: GEOMETRY, cumulative: cumulativeDistancesM(GEOMETRY) };

const near = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} not within ${tolerance} of ${expected}`,
  );

/** Distance along the test route for a point on it. */
const alongOf = (point) => projectOntoRoute(GEOMETRY, point, ROUTE.cumulative).alongM;

test('smoothing helpers', () => {
  assert.equal(smoothingAlpha(0, 1), 0);
  near(smoothingAlpha(1, 1), 1 - Math.exp(-1), 1e-12, 'alpha');
  assert.equal(smoothingAlpha(1, 0), 1);
  assert.equal(angleDiffDeg(350, 10), 20);
  assert.equal(angleDiffDeg(10, 350), -20);
  assert.equal(angleDiffDeg(0, 180), 180);
  near(lerpAngleDeg(350, 10, 0.5), 0, 1e-9, 'wraps through north');
});

test('pointAtDistance walks the polyline and reports segment heading', () => {
  const mid = pointAtDistance(GEOMETRY, ROUTE.cumulative, 1000);
  near(haversineM(mid, START), 1000, 0.5, 'first leg');
  near(mid.heading, 90, 0.5, 'east');
  const second = pointAtDistance(GEOMETRY, ROUTE.cumulative, 2500);
  near(haversineM(second, CORNER), 500, 0.5, 'second leg');
  near(second.heading, 0, 0.5, 'north');
  near(haversineM(pointAtDistance(GEOMETRY, ROUTE.cumulative, 1e9), END), 0, 0.5, 'clamped');
});

test('between fixes the pose keeps moving along the road instead of freezing', () => {
  const s = createFollowSmoother();
  const p0 = destinationPoint(START, 90, 500);
  s.observe({ time: 0, ...p0, alongM: alongOf(p0), speedMps: 10 });
  s.sample(0, ROUTE);
  // Half a second later, with no new fix, the pose has advanced ~ on the road.
  let pose = null;
  for (let t = 16; t <= 1000; t += 16) pose = s.sample(t, ROUTE);
  const advanced = alongOf(pose) - alongOf(p0);
  assert.ok(advanced > 5 && advanced < 12, `advanced ${advanced} m`);
  near(projectOntoRoute(GEOMETRY, pose, ROUTE.cumulative).offRouteM, 0, 0.5, 'stays on the road');
});

test('a new fix is eased toward, not jumped to', () => {
  const s = createFollowSmoother();
  const p0 = destinationPoint(START, 90, 500);
  s.observe({ time: 0, ...p0, alongM: alongOf(p0), speedMps: 10 });
  s.sample(0, ROUTE);
  s.sample(1000, ROUTE);
  // The next fix says we were actually 30 m further along.
  const p1 = destinationPoint(START, 90, 540);
  s.observe({ time: 1000, ...p1, alongM: alongOf(p1), speedMps: 10 });
  const before = s.sample(1000, ROUTE);
  const after = s.sample(1033, ROUTE);
  const step = haversineM(before, after);
  assert.ok(step < 10, `one frame moved ${step} m, not a jump`);
});

test('extrapolation stops after a GPS dropout', () => {
  const s = createFollowSmoother({ positionTauS: 0 });
  const p0 = destinationPoint(START, 90, 100);
  s.observe({ time: 0, ...p0, alongM: alongOf(p0), speedMps: 10 });
  s.sample(0, ROUTE);
  const late = s.sample(10_000, ROUTE);
  near(alongOf(late) - alongOf(p0), 10 * MAX_EXTRAPOLATION_S, 0.5, 'capped prediction');
});

test('a stopped traveller does not creep forward', () => {
  const s = createFollowSmoother({ positionTauS: 0 });
  const p0 = destinationPoint(START, 90, 100);
  s.observe({ time: 0, ...p0, alongM: alongOf(p0), speedMps: 0.2 });
  s.sample(0, ROUTE);
  near(alongOf(s.sample(1500, ROUTE)) - alongOf(p0), 0, 0.01, 'no creep');
});

test('heading turns smoothly through the corner', () => {
  const s = createFollowSmoother();
  const p0 = destinationPoint(START, 90, 1990);
  s.observe({ time: 0, ...p0, alongM: alongOf(p0), speedMps: 10 });
  const first = s.sample(0, ROUTE);
  near(first.heading, 90, 1, 'east before the corner');
  const p1 = destinationPoint(CORNER, 0, 20);
  s.observe({ time: 1000, ...p1, alongM: alongOf(p1), speedMps: 10 });
  const turning = s.sample(1033, ROUTE);
  assert.ok(turning.heading > 0 && turning.heading < 90, `mid-turn heading ${turning.heading}`);
  let last = turning;
  for (let t = 1066; t < 4000; t += 33) last = s.sample(t, ROUTE);
  near(last.heading, 0, 2, 'settles north');
});

test('off route it follows the GPS course and snaps after a big jump', () => {
  const s = createFollowSmoother({ positionTauS: 0 });
  const a = { lat: 18.6, lon: 73.75 };
  s.observe({ time: 0, ...a, alongM: null, speedMps: 5, heading: 0 });
  s.sample(0, null);
  const ahead = s.sample(1000, null);
  near(haversineM(a, ahead), 5, 0.2, 'moved along the course');
  const far = destinationPoint(a, 90, SNAP_DISTANCE_M + 100);
  s.observe({ time: 1000, ...far, alongM: null, speedMps: 0, heading: null });
  near(haversineM(s.sample(1016, null), far), 0, 0.5, 'snapped');
});

test('speed is estimated from movement when the GPS gives none', () => {
  const s = createFollowSmoother({ speedTauS: 0 });
  const p0 = destinationPoint(START, 90, 0);
  const p1 = destinationPoint(START, 90, 15);
  s.observe({ time: 0, ...p0, alongM: 0, speedMps: null });
  s.observe({ time: 1000, ...p1, alongM: 15, speedMps: null });
  near(s.speedMps, 15, 0.5, 'm/s');
});

test('turn arrows and speed text', () => {
  assert.equal(maneuverArrow({ type: 'turn', modifier: 'left' }), '↰');
  assert.equal(maneuverArrow({ type: 'turn', modifier: 'sharp right' }), '↘');
  assert.equal(maneuverArrow({ type: 'end of road', modifier: 'right' }), '↱');
  assert.equal(maneuverArrow({ type: 'continue', modifier: 'straight' }), '↑');
  assert.equal(maneuverArrow({ type: 'continue', modifier: 'slight left' }), '↖');
  assert.equal(maneuverArrow({ type: 'roundabout', modifier: 'right' }), '⟳');
  assert.equal(maneuverArrow({ type: 'arrive' }), '🏁');
  assert.equal(maneuverArrow(null), '↑');
  assert.equal(formatSpeedKmh(10), '36 km/h');
  assert.equal(formatSpeedKmh(null), '');
});
