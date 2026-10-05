/**
 * @module navigation/geolocation
 * @description Thin wrapper over the browser Geolocation API: one-shot fixes,
 * a watch with a stop function, and plain-language errors. Browsers only
 * expose location on HTTPS or localhost, after the user allows it.
 */

/** A normalized GPS fix. */
export function normalizeFix(position) {
  const c = position?.coords;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude))
    return null;
  return {
    lat: c.latitude,
    lon: c.longitude,
    accuracyM: Number.isFinite(c.accuracy) ? c.accuracy : null,
    // Heading is only meaningful while moving; browsers report NaN/null otherwise.
    heading:
      Number.isFinite(c.heading) && Number.isFinite(c.speed) && c.speed > 1.5
        ? c.heading
        : null,
    speedMps: Number.isFinite(c.speed) ? c.speed : null,
    time: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
  };
}

/**
 * Say what went wrong in words a visitor can act on.
 * @param {{code?: number, message?: string}|null} error GeolocationPositionError-like.
 * @param {{secure?: boolean, supported?: boolean}} [context]
 * @returns {string}
 */
export function describeGeoError(
  error,
  { secure = true, supported = true } = {},
) {
  if (!supported) return 'This browser cannot share your location';
  if (!secure) return 'Location needs a secure (https) page';
  switch (error?.code) {
    case 1:
      return 'Location permission denied — allow it in your browser settings';
    case 2:
      return 'Your location is unavailable right now';
    case 3:
      return 'Finding your location took too long — try again';
    default:
      return error?.message || 'Could not get your location';
  }
}

function environment(geo, win) {
  return {
    supported: Boolean(geo?.getCurrentPosition),
    secure: win?.isSecureContext !== false,
  };
}

/**
 * One fix.
 * @param {{geo?: Geolocation, win?: Window, highAccuracy?: boolean}} [options]
 * @returns {Promise<ReturnType<typeof normalizeFix>>} Rejects with a readable Error.
 */
export function getCurrentFix({
  geo = globalThis.navigator?.geolocation,
  win = globalThis.window,
  highAccuracy = true,
} = {}) {
  const env = environment(geo, win);
  if (!env.supported || !env.secure)
    return Promise.reject(new Error(describeGeoError(null, env)));
  return new Promise((resolve, reject) => {
    geo.getCurrentPosition(
      (position) => {
        const fix = normalizeFix(position);
        if (fix) resolve(fix);
        else reject(new Error(describeGeoError({ code: 2 })));
      },
      (error) => reject(new Error(describeGeoError(error, env))),
      { enableHighAccuracy: highAccuracy, timeout: 15_000, maximumAge: 10_000 },
    );
  });
}

/**
 * Continuous fixes until stopped.
 * @param {(fix: object) => void} onFix
 * @param {(message: string) => void} onError
 * @param {{geo?: Geolocation, win?: Window}} [options]
 * @returns {() => void} Stop watching.
 */
export function watchFixes(
  onFix,
  onError,
  { geo = globalThis.navigator?.geolocation, win = globalThis.window } = {},
) {
  const env = environment(geo, win);
  if (!env.supported || !env.secure) {
    onError?.(describeGeoError(null, env));
    return () => {};
  }
  const id = geo.watchPosition(
    (position) => {
      const fix = normalizeFix(position);
      if (fix) onFix(fix);
    },
    (error) => onError?.(describeGeoError(error, env)),
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 2_000 },
  );
  return () => geo.clearWatch(id);
}
