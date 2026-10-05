/**
 * @module navigation/routeProgress
 * @description Pure geometry for live navigation along a Directions route:
 * where a GPS fix sits on the route, how far is left, which maneuver is next,
 * and whether the traveller has left the route. No Cesium, no DOM.
 *
 * Route shape (from the Directions layer): `geometry` is `[[lon, lat], ...]`;
 * `steps[k]` has the maneuver point `{lat, lon}` and `distanceM`, the length
 * travelled AFTER that maneuver, so step k starts at the sum of the distances
 * of the steps before it.
 */

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** A maneuver this close ahead (or already passed) is "now", not "next". */
export const STEP_PASSED_M = 8;
/** Remaining distance at which the trip counts as arrived. */
export const ARRIVAL_RADIUS_M = 30;
/** Off-route threshold floor; widened by poor GPS accuracy. */
export const OFF_ROUTE_MIN_M = 40;
/** Consecutive off-route fixes before a reroute is requested. */
export const OFF_ROUTE_FIXES = 3;
/**
 * A route starts where the router snapped the start to a road, which can be
 * some way from the traveller (a car park, a building set back from the road).
 * Within this distance of that start, before reaching it, they are heading to
 * the route rather than off it.
 */
export const START_APPROACH_M = 250;

/**
 * Great-circle distance in metres.
 * @param {{lat:number, lon:number}} a
 * @param {{lat:number, lon:number}} b
 * @returns {number}
 */
export function haversineM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial bearing from a to b, degrees clockwise from north in [0, 360).
 * @param {{lat:number, lon:number}} a
 * @param {{lat:number, lon:number}} b
 * @returns {number}
 */
export function bearingDeg(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Point `distanceM` from `origin` along `bearing` (degrees).
 * @param {{lat:number, lon:number}} origin
 * @param {number} bearing
 * @param {number} distanceM
 * @returns {{lat:number, lon:number}}
 */
export function destinationPoint(origin, bearing, distanceM) {
  const δ = distanceM / EARTH_RADIUS_M;
  const θ = toRad(bearing);
  const φ1 = toRad(origin.lat);
  const λ1 = toRad(origin.lon);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/**
 * Cumulative distance at each geometry vertex.
 * @param {number[][]} geometry `[[lon, lat], ...]`
 * @returns {number[]}
 */
export function cumulativeDistancesM(geometry) {
  const out = [0];
  for (let i = 1; i < geometry.length; i += 1) {
    const [lon0, lat0] = geometry[i - 1];
    const [lon1, lat1] = geometry[i];
    out.push(
      out[i - 1] +
        haversineM({ lat: lat0, lon: lon0 }, { lat: lat1, lon: lon1 }),
    );
  }
  return out;
}

/**
 * Closest point on the polyline to `point`, using a local equirectangular
 * projection per segment (accurate to well under a metre at street scale).
 * @param {number[][]} geometry `[[lon, lat], ...]`
 * @param {{lat:number, lon:number}} point
 * @param {number[]} [cumulative] Precomputed `cumulativeDistancesM(geometry)`.
 * @returns {{alongM:number, offRouteM:number, segment:number, snapped:{lat:number, lon:number}, heading:number}|null}
 */
export function projectOntoRoute(geometry, point, cumulative) {
  if (!Array.isArray(geometry) || geometry.length < 2) return null;
  const cum = cumulative || cumulativeDistancesM(geometry);
  const mPerDegLat = (Math.PI * EARTH_RADIUS_M) / 180;
  const mPerDegLon = mPerDegLat * Math.cos(toRad(point.lat));
  let best = null;
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const [lon0, lat0] = geometry[i];
    const [lon1, lat1] = geometry[i + 1];
    const ax = (lon0 - point.lon) * mPerDegLon;
    const ay = (lat0 - point.lat) * mPerDegLat;
    const bx = (lon1 - point.lon) * mPerDegLon;
    const by = (lat1 - point.lat) * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx;
    const py = ay + t * dy;
    const dist = Math.hypot(px, py);
    if (!best || dist < best.offRouteM) {
      const segLen = cum[i + 1] - cum[i];
      best = {
        alongM: cum[i] + t * segLen,
        offRouteM: dist,
        segment: i,
        snapped: {
          lat: lat0 + t * (lat1 - lat0),
          lon: lon0 + t * (lon1 - lon0),
        },
        heading: bearingDeg({ lat: lat0, lon: lon0 }, { lat: lat1, lon: lon1 }),
      };
    }
  }
  return best;
}

/**
 * Distance along the route at which each step's maneuver happens.
 * @param {object[]} steps
 * @returns {number[]}
 */
export function stepStartsM(steps) {
  const out = [];
  let sum = 0;
  for (const step of Array.isArray(steps) ? steps : []) {
    out.push(sum);
    sum += Number.isFinite(step?.distanceM) ? step.distanceM : 0;
  }
  return out;
}

/**
 * Off-route threshold for a fix of the given accuracy.
 * @param {number|null|undefined} accuracyM
 * @returns {number}
 */
export function offRouteThresholdM(accuracyM) {
  return Math.max(
    OFF_ROUTE_MIN_M,
    Number.isFinite(accuracyM) ? accuracyM * 1.5 : OFF_ROUTE_MIN_M,
  );
}

/**
 * Everything the navigation readout needs for one GPS fix.
 * @param {{distanceM:number, durationS:number, geometry:number[][], steps:object[]}} route
 * @param {{lat:number, lon:number, accuracyM?:number}} fix
 * @param {{cumulative?: number[], starts?: number[]}} [cache]
 * @returns {null|{alongM:number, remainingM:number, remainingS:number,
 *   offRouteM:number, offRoute:boolean, approachingStart:boolean,
 *   arrived:boolean, heading:number,
 *   snapped:{lat:number, lon:number}, nextStepIndex:number|null,
 *   toNextStepM:number|null}}
 */
export function routeProgress(route, fix, cache = {}) {
  if (!route || !Array.isArray(route.geometry)) return null;
  const cumulative = cache.cumulative || cumulativeDistancesM(route.geometry);
  const projected = projectOntoRoute(route.geometry, fix, cumulative);
  if (!projected) return null;
  const totalM = cumulative[cumulative.length - 1];
  const remainingM = Math.max(0, totalM - projected.alongM);
  const share = totalM > 0 ? remainingM / totalM : 0;
  const starts = cache.starts || stepStartsM(route.steps);
  let nextStepIndex = null;
  for (let k = 1; k < starts.length; k += 1) {
    if (starts[k] > projected.alongM + STEP_PASSED_M) {
      nextStepIndex = k;
      break;
    }
  }
  const beyondThreshold =
    projected.offRouteM > offRouteThresholdM(fix.accuracyM);
  const approachingStart =
    beyondThreshold &&
    projected.alongM < 1 &&
    projected.offRouteM <= START_APPROACH_M;
  const offRoute = beyondThreshold && !approachingStart;
  return {
    alongM: projected.alongM,
    remainingM,
    remainingS: Number.isFinite(route.durationS) ? route.durationS * share : 0,
    offRouteM: projected.offRouteM,
    offRoute,
    approachingStart,
    arrived: !offRoute && remainingM <= ARRIVAL_RADIUS_M,
    heading: projected.heading,
    snapped: projected.snapped,
    nextStepIndex,
    toNextStepM:
      nextStepIndex === null ? null : starts[nextStepIndex] - projected.alongM,
  };
}

/**
 * Camera eye for a chase view: `backM` behind the target along the heading
 * and `upM` above its ground.
 * @param {{lat:number, lon:number}} target
 * @param {number} heading Degrees.
 * @param {{backM?: number, upM?: number}} [options]
 * @returns {{lat:number, lon:number, upM:number, pitchDeg:number}}
 */
export function chaseCamera(target, heading, { backM = 220, upM = 160 } = {}) {
  const eye = destinationPoint(target, (heading + 180) % 360, backM);
  return { ...eye, upM, pitchDeg: -toDeg(Math.atan2(upM, backM)) };
}
