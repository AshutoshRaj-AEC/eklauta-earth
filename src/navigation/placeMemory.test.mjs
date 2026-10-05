import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECENT_PLACES_KEY,
  createPlaceMemory,
  forgetPlace,
  matchPlaces,
  matchScore,
  placeKey,
  rememberPlace,
  validPlace,
} from './placeMemory.js';

const WAKAD = { label: 'Wakad, Pune', lat: 18.6022, lon: 73.7644 };
const MEGAPOLIS = { label: 'Megapolis Sparklet, Hinjawadi', lat: 18.581, lon: 73.6877 };
const AIRPORT = { label: 'Pune International Airport', lat: 18.5821, lon: 73.9197 };

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

test('validPlace rejects malformed entries and clamps labels', () => {
  assert.equal(validPlace(null), null);
  assert.equal(validPlace({ label: '', lat: 1, lon: 1 }), null);
  assert.equal(validPlace({ label: 'x', lat: 91, lon: 1 }), null);
  assert.equal(validPlace({ label: 'x', lat: 'a', lon: 1 }), null);
  assert.equal(validPlace({ label: 'y'.repeat(500), lat: 1, lon: 1 }).label.length, 200);
});

test('remembering moves a place to the top and counts uses', () => {
  let list = [];
  list = rememberPlace(list, WAKAD, 1);
  list = rememberPlace(list, MEGAPOLIS, 2);
  list = rememberPlace(list, { ...WAKAD, label: 'Wakad' }, 3);
  assert.deepEqual(
    list.map((p) => [p.label, p.uses]),
    [
      ['Wakad', 2],
      ['Megapolis Sparklet, Hinjawadi', 1],
    ],
  );
});

test('the same name at a slightly different spot is one entry', () => {
  let list = rememberPlace([], WAKAD, 1);
  list = rememberPlace(list, { ...WAKAD, lat: WAKAD.lat + 0.001 }, 2);
  assert.equal(list.length, 1);
  assert.equal(list[0].uses, 2);
});

test('the list is capped', () => {
  let list = [];
  for (let i = 0; i < 30; i += 1)
    list = rememberPlace(list, { label: `P${i}`, lat: i, lon: i }, i, 20);
  assert.equal(list.length, 20);
  assert.equal(list[0].label, 'P29');
});

test('forgetPlace removes by key', () => {
  const list = rememberPlace(rememberPlace([], WAKAD, 1), AIRPORT, 2);
  assert.deepEqual(
    forgetPlace(list, placeKey(WAKAD)).map((p) => p.label),
    ['Pune International Airport'],
  );
});

test('matching prefers prefixes, then word prefixes, then substrings', () => {
  assert.equal(matchScore('Wakad, Pune', 'wak'), 3);
  assert.equal(matchScore('Pune International Airport', 'pu air'), 2);
  assert.equal(matchScore('Megapolis Sparklet', 'park'), 1);
  assert.equal(matchScore('Wakad', 'xyz'), 0);
  assert.equal(matchScore('Café Goodluck', 'cafe'), 3, 'accents ignored');
  const list = [WAKAD, MEGAPOLIS, AIRPORT].map((p, i) => ({ ...p, uses: 1, lastUsed: i }));
  assert.deepEqual(
    matchPlaces(list, 'pune').map((p) => p.label),
    ['Pune International Airport', 'Wakad, Pune'],
  );
  assert.equal(matchPlaces(list, '').length, 3, 'empty query lists everything');
});

test('createPlaceMemory persists and survives bad or missing storage', () => {
  const storage = memoryStorage();
  const memory = createPlaceMemory({ storage, now: () => 5 });
  memory.remember(WAKAD);
  memory.remember(AIRPORT);
  const reloaded = createPlaceMemory({ storage });
  assert.deepEqual(
    reloaded.list().map((p) => p.label).sort(),
    ['Pune International Airport', 'Wakad, Pune'],
  );
  reloaded.forget(WAKAD);
  assert.equal(createPlaceMemory({ storage }).list().length, 1);
  reloaded.clear();
  assert.equal(storage.getItem(RECENT_PLACES_KEY), null);

  const corrupt = createPlaceMemory({
    storage: memoryStorage({ [RECENT_PLACES_KEY]: '{not json' }),
  });
  assert.deepEqual(corrupt.list(), []);

  const throwing = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
  const sessionOnly = createPlaceMemory({ storage: throwing });
  sessionOnly.remember(WAKAD);
  assert.equal(sessionOnly.list().length, 1, 'still works for the session');
  sessionOnly.clear();
  assert.equal(createPlaceMemory({ storage: null }).list().length, 0);
});
