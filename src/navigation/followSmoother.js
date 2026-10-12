/**
 * @module navigation/followSmoother
 * @description Turns ~1 Hz GPS fixes into a smooth per-frame pose for the
 * position marker and chase camera.
 *
 * Between fixes the pose is predicted forward at the current speed — along
 * the route polyline while on route (so the marker stays on the road), or
 * along the GPS course when off it — and the displayed pose eases toward that
 * prediction, so a new fix corrects course gently instead of jumping. Speed
 * and heading are smoothed too. Pure: no Cesium, no DOM, no clock of its own.
 */

import { bearingDeg, destinationPoint, haversineM } from './routeProgress.js';

/** Never predict further ahead than this after the last fix (GPS dropouts). */
export const MAX_EXTRAPOLATION_S = 2;
/** A displayed pose further than this from the prediction snaps instead of easing. */
export const SNAP_DISTANCE_M = 150;
/** Below this the traveller is treated as stopped (GPS jitter, not motion). */
export const STOPPED_SPEED_MPS = 0.7;
const MAX_SPEED_MPS = 70;

/** Exponential-smoothing weight for a step of `dtS` with time constant `tauS`. */
export function smoothingAlpha(dtS, tauS) {
  if (!(dtS > 0)) return 0;
  if (!(tauS > 0)) return 1;
  return 1 - Math.exp(-dtS / tauS);
}

/** Signed smallest difference `to - from` in degrees, in (-180, 180]. */
export function angleDiffDeg(from, to) {
  const d = ((((to - from) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Interpolate headings along the shorter arc. */
export function lerpAngleDeg(from, to, t) {
  return (from + angleDiffDeg(from, to) * t + 360) % 360;
}

/**
 * Point and travel heading `alongM` metres along the route.
 * @param {number[][]} geometry `[[lon, lat], ...]`
 * @param {number[]} cumulative Distance at each vertex.
 * @param {number} alongM
 * @returns {{lat:number, lon:number, heading:number}|null}
 */
export function pointAtDistance(geometry, cumulative, alongM) {
  if (!Array.isArray(geometry) || geometry.length < 2) return null;
  const total = cumulative[cumulative.length - 1];
  const d = Math.max(0, Math.min(total, alongM));
  let i = 0;
  // Binary search for the segment containing d.
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= d) lo = mid;
    else hi = mid;
  }
  i = lo;
  const [lon0, lat0] = geometry[i];
  const [lon1, lat1] = geometry[i + 1];
  const segment = cumulative[i + 1] - cumulative[i];
  const t = segment > 0 ? (d - cumulative[i]) / segment : 0;
  return {
    lat: lat0 + t * (lat1 - lat0),
    lon: lon0 + t * (lon1 - lon0),
    heading: bearingDeg({ lat: lat0, lon: lon0 }, { lat: lat1, lon: lon1 }),
  };
}

/**
 * @param {{positionTauS?: number, headingTauS?: number, speedTauS?: number}} [options]
 */
export function createFollowSmoother({
  positionTauS = 0.35,
  headingTauS = 0.7,
  speedTauS = 1.5,
} = {}) {
  /** Last observation: what the GPS (and route snapping) said, and when. */
  let observed = null;
  /** Displayed pose. */
  let shown = null;
  let lastSampleMs = null;
  let speedMps = null;

  function estimateSpeed(previous, next) {
    if (Number.isFinite(next.speedMps)) return next.speedMps;
    if (!previous) return 0;
    const dt = (next.time - previous.time) / 1000;
    if (!(dt > 0.2)) return speedMps ?? 0;
    const distance =
      Number.isFinite(next.alongM) && Number.isFinite(previous.alongM)
        ? Math.abs(next.alongM - previous.alongM)
        : haversineM(previous, next);
    return distance / dt;
  }

  return {
    /** Current smoothed speed in m/s (null before the first fix). */
    get speedMps() {
      return speedMps;
    },

    /**
     * Feed one fix.
     * @param {{time:number, lat:number, lon:number, alongM?:number|null,
     *   speedMps?:number|null, heading?:number|null}} observation
     *   `alongM` is the distance along the route when on route, else null.
     */
    observe(observation) {
      const raw = Math.min(
        MAX_SPEED_MPS,
        Math.max(0, estimateSpeed(observed, observation)),
      );
      const dt = observed ? (observation.time - observed.time) / 1000 : 0;
      speedMps =
        speedMps === null
          ? raw
          : speedMps + (raw - speedMps) * smoothingAlpha(dt, speedTauS);
      // Course while off route: GPS heading, else the direction just moved.
      let heading = Number.isFinite(observation.heading)
        ? observation.heading
        : null;
      if (heading === null && observed && haversineM(observed, observation) > 3)
        heading = bearingDeg(observed, observation);
      observed = {
        ...observation,
        alongM: Number.isFinite(observation.alongM) ? observation.alongM : null,
        heading: heading ?? observed?.heading ?? null,
      };
    },

    /**
     * Where to draw the marker and aim the camera at `nowMs`.
     * @param {number} nowMs
     * @param {{geometry: number[][], cumulative: number[]}|null} route
     * @returns {{lat:number, lon:number, heading:number|null}|null}
     */
    sample(nowMs, route) {
      if (!observed) return null;
      const ahead = Math.min(
        MAX_EXTRAPOLATION_S,
        Math.max(0, (nowMs - observed.time) / 1000),
      );
      const moving = (speedMps ?? 0) >= STOPPED_SPEED_MPS;
      let target = null;
      if (observed.alongM !== null && route) {
        target = pointAtDistance(
          route.geometry,
          route.cumulative,
          observed.alongM + (moving ? speedMps * ahead : 0),
        );
      }
      if (!target) {
        const start = { lat: observed.lat, lon: observed.lon };
        const moved =
          moving && Number.isFinite(observed.heading)
            ? destinationPoint(start, observed.heading, speedMps * ahead)
            : start;
        target = { ...moved, heading: observed.heading };
      }
      const dt =
        lastSampleMs === null ? 0 : Math.max(0, (nowMs - lastSampleMs) / 1000);
      lastSampleMs = nowMs;
      if (!shown || haversineM(shown, target) > SNAP_DISTANCE_M) {
        shown = { ...target };
        return { ...shown };
      }
      const a = smoothingAlpha(dt, positionTauS);
      shown.lat += (target.lat - shown.lat) * a;
      shown.lon += (target.lon - shown.lon) * a;
      if (Number.isFinite(target.heading)) {
        // Hold the heading while stopped: GPS course is noise at walking-pace jitter.
        shown.heading = !Number.isFinite(shown.heading)
          ? target.heading
          : moving || observed.alongM !== null
            ? lerpAngleDeg(
                shown.heading,
                target.heading,
                smoothingAlpha(dt, headingTauS),
              )
            : shown.heading;
      }
      return { ...shown };
    },

    reset() {
      observed = null;
      shown = null;
      lastSampleMs = null;
      speedMps = null;
    },
  };
}
