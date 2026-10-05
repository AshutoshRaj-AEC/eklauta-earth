/**
 * @module navigation/placeMemory
 * @description Recently used From/To places, kept in this browser's
 * localStorage (never sent anywhere), plus text matching for suggestions.
 */

export const RECENT_PLACES_KEY = 'eklauta:nav:recent-places:v1';
export const RECENT_PLACES_LIMIT = 20;
const MAX_LABEL = 200;

/** Places closer than ~11 m are the same place. */
export function placeKey(place) {
  return `${Number(place.lat).toFixed(4)},${Number(place.lon).toFixed(4)}`;
}

/** Lowercase, accent-free, punctuation collapsed — for matching only. */
export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A stored entry, or null when it is malformed. */
export function validPlace(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const lat = Number(entry.lat);
  const lon = Number(entry.lon);
  const label = String(entry.label ?? '')
    .trim()
    .slice(0, MAX_LABEL);
  if (!label || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    label,
    lat,
    lon,
    uses: Number.isInteger(entry.uses) && entry.uses > 0 ? entry.uses : 1,
    lastUsed: Number.isFinite(entry.lastUsed) ? entry.lastUsed : 0,
  };
}

/**
 * Record a use of `place`; same spot or same name updates the existing entry.
 * @returns {object[]} New list, most recent first, at most `limit` long.
 */
export function rememberPlace(
  list,
  place,
  now = Date.now(),
  limit = RECENT_PLACES_LIMIT,
) {
  const entry = validPlace({ ...place, uses: 1, lastUsed: now });
  if (!entry) return list;
  const key = placeKey(entry);
  const name = normalizeText(entry.label);
  const previous = list.find(
    (item) => placeKey(item) === key || normalizeText(item.label) === name,
  );
  const merged = previous ? { ...entry, uses: previous.uses + 1 } : entry;
  return [merged, ...list.filter((item) => item !== previous)]
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, limit);
}

/** List without the entry for `key`. */
export function forgetPlace(list, key) {
  return list.filter((item) => placeKey(item) !== key);
}

/**
 * How well `label` matches `query`: 3 starts with it, 2 every word is a word
 * prefix, 1 contains it, 0 no match.
 */
export function matchScore(label, query) {
  const text = normalizeText(label);
  const q = normalizeText(query);
  if (!q) return 1;
  if (text.startsWith(q)) return 3;
  const words = text.split(' ');
  const tokens = q.split(' ');
  if (tokens.every((token) => words.some((word) => word.startsWith(token))))
    return 2;
  return text.includes(q) ? 1 : 0;
}

/**
 * Entries matching `query` (all of them, most used/recent first, when empty).
 * @returns {object[]}
 */
export function matchPlaces(list, query, limit = 5) {
  return list
    .map((item) => ({ item, score: matchScore(item.label, query) }))
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.item.lastUsed - a.item.lastUsed ||
        b.item.uses - a.item.uses,
    )
    .slice(0, limit)
    .map(({ item }) => item);
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked storage (private mode, sandboxed frame)
  }
}

/**
 * Persistent recent places. Every storage access is guarded: when storage is
 * unavailable the memory still works for the session, it just is not kept.
 * @param {{storage?: Storage|null, key?: string, limit?: number, now?: () => number}} [options]
 */
export function createPlaceMemory({
  storage = defaultStorage(),
  key = RECENT_PLACES_KEY,
  limit = RECENT_PLACES_LIMIT,
  now = Date.now,
} = {}) {
  let places = [];
  try {
    const raw = JSON.parse(storage?.getItem(key) || '[]');
    if (Array.isArray(raw))
      places = raw.map(validPlace).filter(Boolean).slice(0, limit);
  } catch {
    places = [];
  }
  const save = () => {
    try {
      storage?.setItem(key, JSON.stringify(places));
    } catch {
      /* quota or blocked storage: keep the in-memory copy */
    }
  };
  return {
    list: () => places.slice(),
    match: (query, max) => matchPlaces(places, query, max),
    remember(place) {
      places = rememberPlace(places, place, now(), limit);
      save();
    },
    forget(placeOrKey) {
      places = forgetPlace(
        places,
        typeof placeOrKey === 'string' ? placeOrKey : placeKey(placeOrKey),
      );
      save();
    },
    clear() {
      places = [];
      try {
        storage?.removeItem(key);
      } catch {
        /* nothing stored */
      }
    },
  };
}
