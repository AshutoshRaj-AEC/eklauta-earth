import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  biasAround,
  mergeSuggestions,
  presetSuggestions,
  searchSuggestions,
} from './placeSuggest.js';

const CITIES = {
  kolkata: {
    name: 'Kolkata',
    pois: [
      { name: 'Victoria Memorial', lat: 22.545, lon: 88.3426 },
      { name: 'Howrah Bridge', lat: 22.5851, lon: 88.3468 },
    ],
  },
  mumbai: { name: 'Mumbai', pois: [{ name: 'Gateway of India', lat: 18.922, lon: 72.8346 }] },
};

const feature = (name, lat, lon, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { name, state: 'Maharashtra', ...extra },
});

test('biasAround builds a centred rectangle', () => {
  assert.equal(biasAround({ lat: 18, lon: 73 }, 0.5), '17.5,72.5|18.5,73.5');
});

test('preset landmarks match by name and carry their city', () => {
  assert.deepEqual(presetSuggestions('howrah', CITIES), [
    { label: 'Howrah Bridge, Kolkata', lat: 22.5851, lon: 88.3468, source: 'preset' },
  ]);
  assert.equal(presetSuggestions('kolkata', CITIES).length, 2, 'city name matches');
  assert.deepEqual(presetSuggestions('v', CITIES), [], 'needs two characters');
});

test('search suggestions: short queries skip the network', async () => {
  let called = false;
  const out = await searchSuggestions('wa', {
    fetchImpl: async () => {
      called = true;
    },
  });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test('search suggestions are normalized, deduplicated and biased', async () => {
  let url = null;
  const fetchImpl = async (requested) => {
    url = new URL(requested);
    return {
      ok: true,
      json: async () => ({
        features: [
          feature('Pune International Airport', 18.5821, 73.9197, { city: 'Pune' }),
          feature('Pune International Airport', 18.583, 73.92, { city: 'Pune' }),
          feature('Pune Station', 18.5289, 73.8744, { city: 'Pune' }),
          { geometry: { type: 'LineString', coordinates: [] }, properties: {} },
        ],
      }),
    };
  };
  const out = await searchSuggestions('pune', {
    fetchImpl,
    bias: biasAround({ lat: 18.59, lon: 73.74 }),
  });
  assert.equal(url.hostname, 'photon.komoot.io');
  assert.equal(url.searchParams.get('q'), 'pune');
  assert.equal(Number(url.searchParams.get('lat')).toFixed(2), '18.59');
  assert.deepEqual(
    out.map((s) => [s.label, s.source]),
    [
      ['Pune International Airport, Pune, Maharashtra', 'search'],
      ['Pune Station, Pune, Maharashtra', 'search'],
    ],
  );
});

test('a failed search answers empty', async () => {
  const out = await searchSuggestions('wakad', {
    fetchImpl: async () => ({ ok: false }),
  });
  assert.deepEqual(out, []);
});

test('merging keeps the first of duplicates by label or spot', () => {
  const merged = mergeSuggestions(
    [{ label: 'Wakad, Pune', lat: 18.6022, lon: 73.7644, source: 'recent' }],
    [{ label: 'My location', lat: 18.6022, lon: 73.7644, source: 'me' }],
    [
      { label: 'wakad pune', lat: 1, lon: 1, source: 'search' },
      { label: 'Wakad Chowk', lat: 18.60221, lon: 73.76441, source: 'search' },
      { label: 'Wakad Flyover', lat: 18.6, lon: 73.76, source: 'search' },
    ],
  );
  assert.deepEqual(
    merged.map((s) => s.label),
    ['Wakad, Pune', 'My location', 'Wakad Flyover'],
  );
});
