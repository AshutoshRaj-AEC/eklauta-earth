import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARRIVAL_RADIUS_M,
  OFF_ROUTE_MIN_M,
  START_APPROACH_M,
  bearingDeg,
  chaseCamera,
  cumulativeDistancesM,
  destinationPoint,
  haversineM,
  offRouteThresholdM,
  projectOntoRoute,
  routeProgress,
  stepStartsM,
} from './routeProgress.js';

// An L-shaped route in Hinjewadi: ~1 km east, then ~1 km north.
const START = { lat: 18.59, lon: 73.73 };
const CORNER = destinationPoint(START, 90, 1000);
const END = destinationPoint(CORNER, 0, 1000);
const ROUTE = {
  distanceM: 2000,
  durationS: 240,
  geometry: [
    [START.lon, START.lat],
    [CORNER.lon, CORNER.lat],
    [END.lon, END.lat],
  ],
  steps: [
    { type: 'depart', distanceM: 1000, lat: START.lat, lon: START.lon },
    { type: 'turn', modifier: 'left', distanceM: 1000, lat: CORNER.lat, lon: CORNER.lon },
    { type: 'arrive', distanceM: 0, lat: END.lat, lon: END.lon },
  ],
};

const near = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} not within ${tolerance} of ${expected}`,
  );

test('haversine and destinationPoint agree', () => {
  near(haversineM(START, CORNER), 1000, 0.5, 'east leg');
  near(haversineM(CORNER, END), 1000, 0.5, 'north leg');
});

test('bearing is clockwise from north', () => {
  near(bearingDeg(START, CORNER), 90, 0.1, 'east');
  near(bearingDeg(CORNER, END), 0, 0.1, 'north');
  near(bearingDeg(END, CORNER), 180, 0.1, 'south');
});

test('cumulative distances and step starts', () => {
  const cum = cumulativeDistancesM(ROUTE.geometry);
  near(cum[2], 2000, 1, 'total');
  assert.deepEqual(stepStartsM(ROUTE.steps), [0, 1000, 2000]);
});

test('a fix beside the first leg projects onto it', () => {
  const beside = destinationPoint(destinationPoint(START, 90, 400), 0, 15);
  const p = projectOntoRoute(ROUTE.geometry, beside);
  near(p.alongM, 400, 2, 'along');
  near(p.offRouteM, 15, 1, 'offset');
  assert.equal(p.segment, 0);
  near(p.heading, 90, 0.5, 'heading');
});

test('progress names the next maneuver and the distance to it', () => {
  const fix = destinationPoint(START, 90, 300);
  const p = routeProgress(ROUTE, fix);
  assert.equal(p.nextStepIndex, 1);
  near(p.toNextStepM, 700, 2, 'to turn');
  near(p.remainingM, 1700, 2, 'remaining');
  near(p.remainingS, 204, 1, 'remaining time scales with distance');
  assert.equal(p.offRoute, false);
  assert.equal(p.arrived, false);
});

test('after the turn the next maneuver is arrival', () => {
  const fix = destinationPoint(CORNER, 0, 200);
  const p = routeProgress(ROUTE, fix);
  assert.equal(p.nextStepIndex, 2);
  near(p.toNextStepM, 800, 2, 'to arrival');
  near(p.heading, 0, 0.5, 'heading north');
});

test('near the end counts as arrived', () => {
  const fix = destinationPoint(END, 180, ARRIVAL_RADIUS_M - 10);
  const p = routeProgress(ROUTE, fix);
  assert.equal(p.arrived, true);
  // The arrive maneuver itself is still the one ahead.
  assert.equal(p.nextStepIndex, 2);
});

test('a fix far from the route is off route, with accuracy widening the band', () => {
  const far = destinationPoint(destinationPoint(START, 90, 500), 180, 120);
  assert.equal(routeProgress(ROUTE, far).offRoute, true);
  assert.equal(routeProgress(ROUTE, { ...far, accuracyM: 100 }).offRoute, false);
  assert.equal(offRouteThresholdM(undefined), OFF_ROUTE_MIN_M);
  assert.equal(offRouteThresholdM(10), OFF_ROUTE_MIN_M);
  assert.equal(offRouteThresholdM(60), 90);
});

test('an off-route fix never counts as arrived', () => {
  const offEnd = destinationPoint(END, 90, 80);
  const p = routeProgress(ROUTE, offEnd);
  assert.equal(p.offRoute, true);
  assert.equal(p.arrived, false);
});

test('degenerate routes return null', () => {
  assert.equal(routeProgress(null, START), null);
  assert.equal(routeProgress({ geometry: [[73.7, 18.5]] }, START), null);
});

test('chase camera sits behind and above, looking down', () => {
  const eye = chaseCamera(CORNER, 0, { backM: 200, upM: 200 });
  near(haversineM(eye, CORNER), 200, 0.5, 'back distance');
  near(bearingDeg(eye, CORNER), 0, 0.5, 'looks along heading');
  near(eye.pitchDeg, -45, 0.01, 'pitch');
});

test("short of the route start is approaching it, not off route", () => {
  // 120 m south-west of the start: the closest route point is the start itself.
  const carPark = destinationPoint(START, 225, 120);
  const p = routeProgress(ROUTE, carPark);
  assert.equal(p.approachingStart, true);
  assert.equal(p.offRoute, false);
  near(p.offRouteM, 120, 1, "gap to start");
  // Beyond the approach radius it is off route again.
  const far = destinationPoint(START, 225, START_APPROACH_M + 50);
  assert.equal(routeProgress(ROUTE, far).offRoute, true);
  // Beside the middle of the route it is off route, not approaching.
  const beside = destinationPoint(destinationPoint(START, 90, 500), 180, 120);
  const q = routeProgress(ROUTE, beside);
  assert.equal(q.approachingStart, false);
  assert.equal(q.offRoute, true);
});
