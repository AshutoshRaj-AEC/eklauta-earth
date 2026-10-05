import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeGeoError,
  getCurrentFix,
  normalizeFix,
  watchFixes,
} from './geolocation.js';

const position = (coords, timestamp = 1000) => ({ coords, timestamp });

test('normalizeFix keeps heading only while moving', () => {
  const moving = normalizeFix(
    position({ latitude: 18.59, longitude: 73.74, accuracy: 8, heading: 90, speed: 10 }),
  );
  assert.deepEqual(moving, {
    lat: 18.59,
    lon: 73.74,
    accuracyM: 8,
    heading: 90,
    speedMps: 10,
    time: 1000,
  });
  const still = normalizeFix(
    position({ latitude: 18.59, longitude: 73.74, accuracy: 8, heading: 90, speed: 0 }),
  );
  assert.equal(still.heading, null);
  assert.equal(normalizeFix(position({ latitude: NaN, longitude: 1 })), null);
  assert.equal(normalizeFix(null), null);
});

test('errors read as instructions', () => {
  assert.match(describeGeoError({ code: 1 }), /permission denied/);
  assert.match(describeGeoError({ code: 3 }), /too long/);
  assert.match(describeGeoError(null, { supported: false }), /cannot share/);
  assert.match(describeGeoError(null, { secure: false }), /https/);
});

test('getCurrentFix resolves a normalized fix', async () => {
  const geo = {
    getCurrentPosition: (ok) => ok(position({ latitude: 1, longitude: 2, accuracy: 5 })),
  };
  const fix = await getCurrentFix({ geo, win: { isSecureContext: true } });
  assert.equal(fix.lat, 1);
  assert.equal(fix.lon, 2);
});

test('getCurrentFix rejects readably on denial and on insecure pages', async () => {
  const denied = { getCurrentPosition: (_ok, fail) => fail({ code: 1 }) };
  await assert.rejects(
    getCurrentFix({ geo: denied, win: { isSecureContext: true } }),
    /permission denied/,
  );
  await assert.rejects(
    getCurrentFix({ geo: denied, win: { isSecureContext: false } }),
    /https/,
  );
});

test('watchFixes streams fixes and stops with clearWatch', () => {
  let cleared = null;
  let emit = null;
  const geo = {
    getCurrentPosition() {},
    watchPosition(ok) {
      emit = ok;
      return 7;
    },
    clearWatch(id) {
      cleared = id;
    },
  };
  const fixes = [];
  const stop = watchFixes((fix) => fixes.push(fix), null, {
    geo,
    win: { isSecureContext: true },
  });
  emit(position({ latitude: 1, longitude: 2 }));
  emit(position({ latitude: 3, longitude: 4 }));
  assert.deepEqual(
    fixes.map((f) => [f.lat, f.lon]),
    [
      [1, 2],
      [3, 4],
    ],
  );
  stop();
  assert.equal(cleared, 7);
});
