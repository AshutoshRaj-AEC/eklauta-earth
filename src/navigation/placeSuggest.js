/**
 * @module navigation/placeSuggest
 * @description Search-as-you-type candidates for the From/To fields: preset
 * landmarks (instant, offline) and Photon results (komoot's OSM search, which
 * is built for autocomplete — Nominatim's policy forbids that use).
 */

import { normalizePhotonFeature, photonSearchUrl } from '../keylessGeocoder.js';
import { matchScore, normalizeText } from './placeMemory.js';

/** Characters typed before a network search runs. */
export const SEARCH_MIN_CHARS = 3;

/**
 * A soft bias rectangle (`"swLat,swLng|neLat,neLng"`, the viewportBias format)
 * centred on a point; Photon only uses its centre.
 */
export function biasAround({ lat, lon }, halfDeg = 0.2) {
  return `${lat - halfDeg},${lon - halfDeg}|${lat + halfDeg},${lon + halfDeg}`;
}

/**
 * Preset landmarks matching `query`, labelled with their city.
 * @param {string} query
 * @param {Record<string, {name: string, pois: object[]}>} cities
 * @returns {{label: string, lat: number, lon: number, source: 'preset'}[]}
 */
export function presetSuggestions(query, cities, limit = 4) {
  if (normalizeText(query).length < 2) return [];
  const out = [];
  for (const city of Object.values(cities || {})) {
    for (const poi of city?.pois || []) {
      const label = `${poi.name}, ${city.name}`;
      const score = Math.max(
        matchScore(poi.name, query),
        matchScore(label, query),
      );
      if (score > 0)
        out.push({
          label,
          lat: poi.lat,
          lon: poi.lon,
          source: 'preset',
          score,
        });
    }
  }
  return out
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...rest }) => rest);
}

/**
 * Photon candidates for `query`, deduplicated by label.
 * @param {string} query
 * @param {{bias?: string|null, signal?: AbortSignal, fetchImpl?: typeof fetch, limit?: number}} [options]
 * @returns {Promise<{label: string, lat: number, lon: number, source: 'search'}[]>}
 */
export async function searchSuggestions(
  query,
  {
    bias = null,
    signal,
    fetchImpl = (...args) => fetch(...args),
    limit = 6,
  } = {},
) {
  const text = String(query ?? '').trim();
  if (text.length < SEARCH_MIN_CHARS) return [];
  const response = await fetchImpl(
    photonSearchUrl(text, { bias, limit: limit + 2 }),
    {
      signal,
      headers: { Accept: 'application/json' },
    },
  );
  if (!response.ok) return [];
  const payload = await response.json();
  const seen = new Set();
  const out = [];
  for (const feature of payload?.features || []) {
    const place = normalizePhotonFeature(feature);
    if (!place) continue;
    const key = normalizeText(place.label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: place.label,
      lat: place.lat,
      lon: place.lng,
      source: 'search',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Merge suggestion groups in order, dropping later duplicates (same label or
 * within ~11 m of an earlier entry).
 */
export function mergeSuggestions(...groups) {
  const labels = new Set();
  const spots = new Set();
  const out = [];
  for (const group of groups) {
    for (const item of group || []) {
      const label = normalizeText(item.label);
      const spot = `${Number(item.lat).toFixed(4)},${Number(item.lon).toFixed(4)}`;
      if (labels.has(label) || (item.source !== 'me' && spots.has(spot)))
        continue;
      labels.add(label);
      if (item.source !== 'me') spots.add(spot);
      out.push(item);
    }
  }
  return out;
}
