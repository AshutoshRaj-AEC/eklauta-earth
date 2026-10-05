import * as Cesium from 'cesium';

/**
 * Camera presets for notable locations.
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Opening view: Hinjewadi, Pune. The fly-in ends south-southwest of Shivaji
 * Chowk so the chowk sits mid-frame along the heading. Heights are WGS84
 * ellipsoidal; local ground is ~500 m, so the end height is ~900 m above it.
 */
export const START_VIEW = Object.freeze({
  label: 'Hinjewadi, Pune',
  overview: { lon: 73.739, lat: 18.5913, height: 25000 },
  arrival: {
    lon: 73.7352,
    lat: 18.5777,
    height: 1400,
    heading: 15,
    pitch: -30,
  },
});

/**
 * Set camera to the start view on load with a cinematic fly-in.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToStartView(viewer) {
  const { overview, arrival } = START_VIEW;
  // Start from a high altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      overview.lon,
      overview.lat,
      overview.height,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        arrival.lon,
        arrival.lat,
        arrival.height,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(arrival.heading),
        pitch: Cesium.Math.toRadians(arrival.pitch),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}
