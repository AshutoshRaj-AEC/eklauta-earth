/**
 * @module navigation/navigationPanel
 * @description EklautA Earth navigation: a "my location" button, a From/To
 * directions form, and a live follow mode that tracks GPS along the route.
 *
 * Routing itself is the Directions layer's (`/api/route`, OSRM on the FOSSGIS
 * servers): this panel geocodes typed places, places the layer's A and B, and
 * reads the route back. Live mode reroutes by moving A to the current fix, at
 * most once per REROUTE_MIN_INTERVAL_MS, to respect that service's usage policy.
 */

import * as Cesium from 'cesium';
import { MENU_CITIES, flyToLandmark } from '../locations.js';
import { viewportBias } from '../annotations/annotationResolver.js';
import { cachedGroundFloor, warmGroundFloor } from '../data/groundFloor.js';
import { governorRequestRender } from '../renderGovernor.js';
import {
  formatRouteDistance,
  formatRouteDuration,
} from '../data/routeSteps.js';
import { getCurrentFix, watchFixes } from './geolocation.js';
import { createPlaceMemory, matchScore } from './placeMemory.js';
import {
  SEARCH_MIN_CHARS,
  biasAround,
  mergeSuggestions,
  presetSuggestions,
  searchSuggestions,
} from './placeSuggest.js';
import {
  OFF_ROUTE_FIXES,
  chaseCamera,
  cumulativeDistancesM,
  routeProgress,
  stepStartsM,
} from './routeProgress.js';

/** Typed into "From" (or chosen with its 📍 button) to start at the GPS fix. */
export const MY_LOCATION_LABEL = 'My location';
export const REROUTE_MIN_INTERVAL_MS = 15_000;
/** Speak the upcoming maneuver once when it gets this close. */
const ANNOUNCE_AHEAD_M = 150;
const MODES = [
  ['car', '🚗 DRIVE'],
  ['foot', '🚶 WALK'],
  ['bike', '🚲 BIKE'],
];
/** Chase-camera distances per travel mode. */
const CHASE = {
  car: { backM: 240, upM: 170 },
  bike: { backM: 150, upM: 110 },
  foot: { backM: 90, upM: 75 },
};

const ground = { cachedGroundFloor, warmGroundFloor };

/** Whether a From/To value means "use my GPS fix". */
export function isMyLocation(value) {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return text === '' || text === MY_LOCATION_LABEL.toLowerCase();
}

/** "Turn left onto Wakad Road" for a step, with a fallback. */
export function stepInstruction(step) {
  if (!step) return '';
  if (step.instruction) return step.instruction;
  return step.name ? `Continue on ${step.name}` : 'Continue';
}

/** Local clock time `seconds` from now, e.g. "14:05". */
export function etaClock(seconds, now = new Date()) {
  const at = new Date(now.getTime() + Math.max(0, seconds) * 1000);
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const PANEL_HTML = `
  <div class="nav-panel-head">
    <span class="nav-panel-title">🧭 DIRECTIONS</span>
    <button type="button" class="nav-icon-btn" data-nav="close" aria-label="Close directions">✕</button>
  </div>
  <div class="nav-form" data-nav="form">
    <div class="nav-field">
      <span class="nav-dot nav-dot-a" aria-hidden="true">A</span>
      <input type="text" data-nav="from" placeholder="From — place, or My location" autocomplete="off" spellcheck="false" aria-label="Start" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="nav-from-suggest" />
      <button type="button" class="nav-icon-btn" data-nav="from-me" title="Start from my location" aria-label="Start from my location">📍</button>
      <div class="nav-suggest" id="nav-from-suggest" data-nav="from-suggest" role="listbox" aria-label="Start suggestions" hidden></div>
    </div>
    <div class="nav-field">
      <span class="nav-dot nav-dot-b" aria-hidden="true">B</span>
      <input type="text" data-nav="to" placeholder="To — search a place" autocomplete="off" spellcheck="false" aria-label="Destination" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="nav-to-suggest" />
      <button type="button" class="nav-icon-btn" data-nav="swap" title="Swap start and destination" aria-label="Swap start and destination">⇅</button>
      <div class="nav-suggest" id="nav-to-suggest" data-nav="to-suggest" role="listbox" aria-label="Destination suggestions" hidden></div>
    </div>
    <div class="nav-modes" role="group" aria-label="Travel mode" data-nav="modes"></div>
    <div class="nav-actions">
      <button type="button" class="nav-btn nav-btn-primary" data-nav="route">ROUTE</button>
      <button type="button" class="nav-btn" data-nav="start" disabled>▶ START</button>
      <button type="button" class="nav-btn" data-nav="clear">CLEAR</button>
    </div>
  </div>
  <div class="nav-live" data-nav="live" hidden>
    <div class="nav-live-next">
      <div class="nav-live-dist" data-nav="next-dist">—</div>
      <div class="nav-live-instr" data-nav="next-instr">Waiting for GPS…</div>
    </div>
    <div class="nav-live-meta" data-nav="live-meta"></div>
    <div class="nav-actions">
      <button type="button" class="nav-btn" data-nav="recenter" hidden>⌖ RE-CENTER</button>
      <button type="button" class="nav-btn" data-nav="voice" aria-pressed="false">🔇 VOICE</button>
      <button type="button" class="nav-btn nav-btn-danger" data-nav="stop">■ STOP</button>
    </div>
  </div>
  <div class="nav-status" data-nav="status" role="status" aria-live="polite"></div>
`;

/**
 * Mount the navigation controls.
 * @param {{viewer: Cesium.Viewer, dataManager: object, shell: object,
 *   placeSearch: {geocode: Function}, doc?: Document}} options
 * @returns {{destroy: () => void, locate: () => Promise<void>}}
 */
export function createNavigationPanel({
  viewer,
  dataManager,
  shell,
  placeSearch,
  doc = document,
}) {
  const win = doc.defaultView || globalThis.window;
  const toast = (text) => shell?._showToast?.(text);

  // --- DOM ---------------------------------------------------------------
  const fabs = doc.createElement('div');
  fabs.id = 'nav-fabs';
  fabs.innerHTML = `
    <button type="button" class="nav-fab" data-nav="locate" title="Show my location" aria-label="Show my location">📍</button>
    <button type="button" class="nav-fab" data-nav="toggle" title="Directions" aria-label="Directions" aria-expanded="false">🧭</button>`;
  const panel = doc.createElement('section');
  panel.id = 'nav-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Directions');
  panel.innerHTML = PANEL_HTML;
  doc.body.append(fabs, panel);

  const q = (root, name) => root.querySelector(`[data-nav="${name}"]`);
  const el = {
    locate: q(fabs, 'locate'),
    toggle: q(fabs, 'toggle'),
    close: q(panel, 'close'),
    form: q(panel, 'form'),
    from: q(panel, 'from'),
    fromSuggest: q(panel, 'from-suggest'),
    fromMe: q(panel, 'from-me'),
    to: q(panel, 'to'),
    toSuggest: q(panel, 'to-suggest'),
    swap: q(panel, 'swap'),
    modes: q(panel, 'modes'),
    route: q(panel, 'route'),
    start: q(panel, 'start'),
    clear: q(panel, 'clear'),
    live: q(panel, 'live'),
    nextDist: q(panel, 'next-dist'),
    nextInstr: q(panel, 'next-instr'),
    liveMeta: q(panel, 'live-meta'),
    recenter: q(panel, 'recenter'),
    voice: q(panel, 'voice'),
    stop: q(panel, 'stop'),
    status: q(panel, 'status'),
  };
  el.from.value = MY_LOCATION_LABEL;
  let mode = 'car';
  for (const [id, label] of MODES) {
    const chip = doc.createElement('button');
    chip.type = 'button';
    chip.className = 'nav-chip';
    chip.dataset.mode = id;
    chip.textContent = label;
    el.modes.append(chip);
  }

  // --- State ---------------------------------------------------------------
  let destroyed = false;
  let lastFix = null;
  /** Places used before, kept in this browser only. */
  const memory = createPlaceMemory();
  let marker = null;
  let routeToken = 0;
  let unsubscribeRoute = null;
  let route = null;
  let routeCache = null;
  // Live navigation.
  let stopWatch = null;
  let navigating = false;
  let followPaused = false;
  let offRouteCount = 0;
  let lastRerouteAt = 0;
  let rerouting = false;
  let announcedStep = null;
  let voiceOn = false;
  let wakeLock = null;

  const directions = () => dataManager?.layers?.get('directions')?.module;
  const setStatus = (text, kind = '') => {
    el.status.textContent = text || '';
    el.status.dataset.kind = kind;
  };
  const render = (reason) => governorRequestRender(`navigation-${reason}`);

  function syncModes() {
    for (const chip of el.modes.children)
      chip.classList.toggle('active', chip.dataset.mode === mode);
  }
  syncModes();

  // --- My location marker (Phase A) ----------------------------------------
  function showMarker(fix) {
    if (!viewer || viewer.isDestroyed?.()) return;
    const position = Cesium.Cartesian3.fromDegrees(fix.lon, fix.lat, 0);
    const radius = Math.max(5, Math.min(fix.accuracyM || 15, 2000));
    if (!marker) {
      marker = viewer.entities.add({
        id: 'navigation:me',
        position,
        point: {
          pixelSize: 16,
          color: Cesium.Color.fromCssColorString('#2f8cff'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 3,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          material: Cesium.Color.fromCssColorString('#2f8cff').withAlpha(0.16),
          outline: false,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
    } else {
      marker.position = position;
      marker.ellipse.semiMajorAxis = radius;
      marker.ellipse.semiMinorAxis = radius;
    }
    render('marker');
  }

  function removeMarker() {
    if (marker && viewer && !viewer.isDestroyed?.())
      viewer.entities.remove(marker);
    marker = null;
    render('marker');
  }

  async function locate() {
    el.locate.classList.add('busy');
    try {
      const fix = await getCurrentFix({ win });
      if (destroyed) return;
      lastFix = fix;
      showMarker(fix);
      shell?.runImmediateNavigation?.('location', () => {
        flyToLandmark(viewer, fix.lat, fix.lon, {
          range: 700,
          pitch: -50,
          heading: 0,
          buildingHeight: 0,
          duration: 2.5,
          ground,
        });
        return true;
      });
      const accuracy = Number.isFinite(fix.accuracyM)
        ? ` (±${formatRouteDistance(fix.accuracyM)})`
        : '';
      toast(`📍 You are here${accuracy}`);
    } catch (error) {
      toast(error.message);
    } finally {
      el.locate.classList.remove('busy');
    }
  }

  // --- Directions form (Phase B) --------------------------------------------
  /** The exact place chosen for an input, if its text still matches it. */
  function chosenPlace(input) {
    const { label, lat, lon } = input.dataset;
    if (!label || label !== input.value.trim()) return null;
    const place = { label, lat: Number(lat), lon: Number(lon) };
    return Number.isFinite(place.lat) && Number.isFinite(place.lon)
      ? place
      : null;
  }

  function setChosen(input, place) {
    if (!place) {
      delete input.dataset.label;
      delete input.dataset.lat;
      delete input.dataset.lon;
      return;
    }
    input.value = place.label;
    input.dataset.label = place.label;
    input.dataset.lat = String(place.lat);
    input.dataset.lon = String(place.lon);
  }

  function currentBias() {
    if (lastFix) return biasAround(lastFix);
    try {
      return viewportBias(viewer);
    } catch {
      return null;
    }
  }

  async function resolvePlace(input, which) {
    const value = input.value;
    const chosen = !isMyLocation(value) && chosenPlace(input);
    if (chosen) return chosen;
    if (isMyLocation(value)) {
      const fix = await getCurrentFix({ win });
      lastFix = fix;
      showMarker(fix);
      return { lat: fix.lat, lon: fix.lon, label: MY_LOCATION_LABEL };
    }
    const text = String(value).trim();
    const coords = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(
      text,
    );
    if (coords) {
      const lat = Number(coords[1]);
      const lon = Number(coords[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
        return { lat, lon, label: text };
    }
    const result = await placeSearch.geocode(text, { bias: currentBias() });
    const place = result?.place;
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng))
      throw new Error(`Couldn't find "${text}" for ${which}`);
    return {
      lat: place.lat,
      lon: place.lng,
      label: place.label || place.name || text,
    };
  }

  async function ensureDirectionsLayer() {
    const layer = directions();
    if (!layer) throw new Error('Directions are unavailable in this build');
    if (!dataManager.isEnabled?.('directions'))
      await dataManager.setEnabled('directions', true, { origin: 'user' });
    if (!unsubscribeRoute && typeof layer.addRouteListener === 'function')
      unsubscribeRoute = layer.addRouteListener(onRouteSnapshot);
    return layer;
  }

  function frameRoute(next) {
    if (!next?.geometry?.length) return;
    let west = 180;
    let south = 90;
    let east = -180;
    let north = -90;
    for (const [lon, lat] of next.geometry) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
    const padLat = Math.max((north - south) * 0.25, 0.004);
    const padLon = Math.max((east - west) * 0.25, 0.004);
    shell?.runImmediateNavigation?.('route', () => {
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          west - padLon,
          south - padLat,
          east + padLon,
          north + padLat,
        ),
        duration: 2.2,
      });
      return true;
    });
  }

  function summary(next) {
    return `${formatRouteDistance(next.distanceM)} · ${formatRouteDuration(next.durationS)}`;
  }

  function setRoute(next) {
    route = next;
    routeCache = next
      ? {
          cumulative: cumulativeDistancesM(next.geometry),
          starts: stepStartsM(next.steps),
        }
      : null;
    el.start.disabled = !route || navigating;
  }

  function onRouteSnapshot(snapshot) {
    if (destroyed) return;
    const status = snapshot?.status;
    // While a new route is being fetched the old one stays in use, so live
    // navigation keeps working through a reroute.
    if (status === 'routing') {
      if (!navigating) setStatus('Finding a route…');
      return;
    }
    if (status === 'error') {
      if (navigating && route) {
        rerouting = false;
        setStatus(`Reroute failed: ${snapshot.error || 'no route'}`, 'error');
        return;
      }
      setRoute(null);
      setStatus(snapshot.error || 'No route found', 'error');
      return;
    }
    if (status === 'ready' && snapshot.route) {
      if (snapshot.route === route) return;
      setRoute(snapshot.route);
      if (rerouting) {
        rerouting = false;
        offRouteCount = 0;
        announcedStep = null;
        setStatus('');
        toast('Route updated');
      } else if (!navigating) {
        setStatus(`${summary(route)} — press START to navigate`);
        frameRoute(route);
      }
      return;
    }
    // Cleared (idle) or layer switched off.
    if (navigating) stopNavigation({ quiet: true });
    setRoute(null);
    setStatus('');
  }

  async function planRoute() {
    const token = ++routeToken;
    el.route.disabled = true;
    setStatus('Locating places…');
    try {
      const [a, b] = await Promise.all([
        resolvePlace(el.from, 'the start'),
        resolvePlace(el.to, 'the destination'),
      ]);
      if (destroyed || token !== routeToken) return;
      if (!String(el.to.value).trim()) throw new Error('Enter a destination');
      // Remember both ends for next time (never the moving "My location").
      for (const [input, place] of [
        [el.from, a],
        [el.to, b],
      ]) {
        if (place.label === MY_LOCATION_LABEL) continue;
        setChosen(input, place);
        memory.remember(place);
      }
      const layer = await ensureDirectionsLayer();
      layer.setParams({ mode });
      layer.placeEndpoint('a', { lat: a.lat, lon: a.lon });
      layer.placeEndpoint('b', { lat: b.lat, lon: b.lon });
      setStatus('Finding a route…');
    } catch (error) {
      if (token === routeToken) setStatus(error.message, 'error');
    } finally {
      if (token === routeToken) el.route.disabled = false;
    }
  }

  function clearRoute() {
    stopNavigation({ quiet: true });
    routeToken += 1;
    directions()?.setParams?.({ clear: true });
    route = null;
    routeCache = null;
    el.to.value = '';
    setChosen(el.to, null);
    el.start.disabled = true;
    setStatus('');
  }

  // --- Live navigation (Phase C) --------------------------------------------
  function speak(text) {
    if (!voiceOn || !text) return;
    try {
      const synth = win?.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      synth.speak(new win.SpeechSynthesisUtterance(text));
    } catch {
      /* speech is optional */
    }
  }

  async function holdWakeLock() {
    try {
      wakeLock = (await win?.navigator?.wakeLock?.request?.('screen')) || null;
    } catch {
      wakeLock = null;
    }
  }

  function followCamera(fix, progress) {
    if (followPaused || !viewer || viewer.isDestroyed?.()) return;
    const heading = Number.isFinite(fix.heading)
      ? fix.heading
      : progress.heading;
    const target = progress.offRoute ? fix : progress.snapped;
    const eye = chaseCamera(target, heading, CHASE[mode] || CHASE.car);
    const floor =
      cachedGroundFloor(target.lat, target.lon) ??
      viewer.scene.globe?.getHeight?.(
        Cesium.Cartographic.fromDegrees(target.lon, target.lat),
      ) ??
      0;
    warmGroundFloor([{ lat: target.lat, lon: target.lon }]);
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        eye.lon,
        eye.lat,
        floor + eye.upM,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(heading),
        pitch: Cesium.Math.toRadians(eye.pitchDeg),
        roll: 0,
      },
      duration: 0.9,
      easingFunction: Cesium.EasingFunction.LINEAR_NONE,
    });
  }

  function updateLive(fix) {
    // One route for the whole update, even if a reroute replaces it meanwhile.
    const current = route;
    if (!navigating || !current) return;
    const progress = routeProgress(current, fix, routeCache);
    if (!progress) return;
    if (progress.arrived) {
      el.nextDist.textContent = '🏁';
      el.nextInstr.textContent = 'You have arrived';
      el.liveMeta.textContent = el.to.value ? String(el.to.value) : '';
      speak('You have arrived');
      stopNavigation({ quiet: true, keepPanel: true });
      setStatus('Arrived at your destination');
      return;
    }
    // Off route: count consecutive fixes, then reroute from here (throttled).
    if (progress.offRoute) offRouteCount += 1;
    else offRouteCount = 0;
    const now = Date.now();
    if (
      offRouteCount >= OFF_ROUTE_FIXES &&
      !rerouting &&
      now - lastRerouteAt >= REROUTE_MIN_INTERVAL_MS
    ) {
      rerouting = true;
      lastRerouteAt = now;
      setStatus('Off route — rerouting…');
      speak('Rerouting');
      directions()?.placeEndpoint?.('a', { lat: fix.lat, lon: fix.lon });
    }
    const step = current.steps[progress.nextStepIndex];
    el.nextDist.textContent =
      progress.toNextStepM === null
        ? ''
        : formatRouteDistance(progress.toNextStepM);
    el.nextInstr.textContent = progress.offRoute
      ? 'Off route — head back to the blue line'
      : progress.approachingStart
        ? `Head to the route (${formatRouteDistance(progress.offRouteM)})`
        : stepInstruction(step);
    el.liveMeta.textContent =
      `${formatRouteDistance(progress.remainingM)} left · ` +
      `${formatRouteDuration(progress.remainingS)} · ETA ${etaClock(progress.remainingS)}`;
    if (
      !progress.offRoute &&
      step &&
      progress.toNextStepM !== null &&
      progress.toNextStepM <= ANNOUNCE_AHEAD_M &&
      announcedStep !== progress.nextStepIndex
    ) {
      announcedStep = progress.nextStepIndex;
      speak(
        `In ${formatRouteDistance(progress.toNextStepM)}, ${stepInstruction(step)}`,
      );
    }
    if (!rerouting && !progress.offRoute) setStatus('');
    followCamera(fix, progress);
  }

  function onFix(fix) {
    if (destroyed) return;
    lastFix = fix;
    showMarker(fix);
    updateLive(fix);
  }

  function pauseFollow() {
    if (!navigating || followPaused) return;
    followPaused = true;
    el.recenter.hidden = false;
  }

  function startNavigation() {
    if (!route || navigating) return;
    const claimed = shell?.runImmediateNavigation?.('route', () => true);
    if (claimed === false) return;
    navigating = true;
    openPanel(true);
    followPaused = false;
    offRouteCount = 0;
    announcedStep = null;
    rerouting = false;
    panel.classList.add('navigating');
    el.form.hidden = true;
    el.live.hidden = false;
    el.recenter.hidden = true;
    el.start.disabled = true;
    el.nextDist.textContent = '—';
    el.nextInstr.textContent = 'Waiting for GPS…';
    el.liveMeta.textContent = summary(route);
    setStatus('');
    void holdWakeLock();
    stopWatch = watchFixes(onFix, (message) => setStatus(message, 'error'), {
      win,
    });
    if (lastFix) updateLive(lastFix);
    speak(stepInstruction(route.steps[0]));
  }

  function stopNavigation({ quiet = false, keepPanel = false } = {}) {
    stopWatch?.();
    stopWatch = null;
    try {
      wakeLock?.release?.();
    } catch {
      /* already released */
    }
    wakeLock = null;
    if (!navigating) return;
    navigating = false;
    followPaused = false;
    rerouting = false;
    try {
      win?.speechSynthesis?.cancel();
    } catch {
      /* speech is optional */
    }
    panel.classList.remove('navigating');
    if (!keepPanel) {
      el.live.hidden = true;
      el.form.hidden = false;
    } else {
      el.recenter.hidden = true;
      el.stop.textContent = 'DONE';
    }
    el.start.disabled = !route;
    if (!quiet)
      setStatus(route ? `${summary(route)} — press START to navigate` : '');
  }

  // --- Suggestions: recent places, my location, landmarks, search ----------
  const ICONS = { recent: '🕘', me: '📍', preset: '⭐', search: '🔎' };

  function createSuggest(input, list, kind) {
    let items = [];
    let active = -1;
    let timer = null;
    let abort = null;
    let seq = 0;
    let searching = false;

    const open = () => !list.hidden;
    const queryOf = () => {
      const text = input.value.trim();
      return isMyLocation(text) ? '' : text;
    };

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
      clearTimeout(timer);
      abort?.abort();
      searching = false;
    }

    function localItems(query) {
      const me =
        kind === 'from' && (!query || matchScore(MY_LOCATION_LABEL, query) > 0)
          ? [{ label: MY_LOCATION_LABEL, source: 'me' }]
          : [];
      const recent = memory
        .match(query, query ? 4 : 6)
        .map((place) => ({ ...place, source: 'recent' }));
      return mergeSuggestions(
        me,
        recent,
        presetSuggestions(query, MENU_CITIES),
      );
    }

    function render(query) {
      list.replaceChildren();
      items.forEach((item, index) => {
        const row = doc.createElement('div');
        row.className = 'nav-suggest-item';
        row.id = list.id + '-' + index;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === active));
        row.dataset.index = String(index);
        const icon = doc.createElement('span');
        icon.className = 'nav-suggest-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = ICONS[item.source] || '•';
        const label = doc.createElement('span');
        label.className = 'nav-suggest-label';
        label.textContent = item.label;
        row.append(icon, label);
        if (item.source === 'recent') {
          const forget = doc.createElement('button');
          forget.type = 'button';
          forget.className = 'nav-suggest-forget';
          forget.dataset.forget = String(index);
          forget.setAttribute('aria-label', 'Forget ' + item.label);
          forget.title = 'Forget this place';
          forget.textContent = '✕';
          row.append(forget);
        }
        list.append(row);
      });
      const note = searching
        ? 'Searching…'
        : !items.length && query.length >= SEARCH_MIN_CHARS
          ? 'No matches'
          : '';
      if (note) {
        const row = doc.createElement('div');
        row.className = 'nav-suggest-note';
        row.textContent = note;
        list.append(row);
      }
      if (!query && memory.list().length) {
        const clear = doc.createElement('button');
        clear.type = 'button';
        clear.className = 'nav-suggest-clear';
        clear.dataset.clearHistory = 'true';
        clear.textContent = 'Clear recent places';
        list.append(clear);
      }
      const visible = list.children.length > 0;
      list.hidden = !visible;
      input.setAttribute('aria-expanded', String(visible));
      if (active >= 0)
        input.setAttribute('aria-activedescendant', list.id + '-' + active);
      else input.removeAttribute('aria-activedescendant');
    }

    function update() {
      const query = queryOf();
      clearTimeout(timer);
      abort?.abort();
      active = -1;
      items = localItems(query);
      searching = query.length >= SEARCH_MIN_CHARS;
      render(query);
      if (!searching) return;
      const mine = ++seq;
      timer = setTimeout(async () => {
        abort = new AbortController();
        let results = [];
        try {
          results = await searchSuggestions(query, {
            bias: currentBias(),
            signal: abort.signal,
          });
        } catch {
          results = [];
        }
        if (mine !== seq || destroyed || doc.activeElement !== input) return;
        searching = false;
        items = mergeSuggestions(localItems(query), results);
        render(query);
      }, 300);
    }

    function choose(index) {
      const item = items[index];
      if (!item) return;
      if (item.source === 'me') {
        input.value = MY_LOCATION_LABEL;
        setChosen(input, null);
      } else setChosen(input, item);
      close();
      if (kind === 'to') void planRoute();
      else el.to.focus();
    }

    function move(delta) {
      if (!items.length) return;
      active = (active + delta + items.length) % items.length;
      render(queryOf());
      list
        .querySelector('#' + list.id + '-' + active)
        ?.scrollIntoView?.({ block: 'nearest' });
    }

    /** @returns {boolean} whether the key was handled here. */
    function onKey(event) {
      if (event.key === 'ArrowDown') {
        if (!open()) update();
        move(1);
        return true;
      }
      if (event.key === 'ArrowUp' && open()) {
        move(-1);
        return true;
      }
      if (event.key === 'Enter' && open() && active >= 0) {
        choose(active);
        return true;
      }
      if (event.key === 'Escape' && open()) {
        close();
        return true;
      }
      return false;
    }

    // Keep focus in the input while tapping the list.
    on(list, 'pointerdown', (event) => event.preventDefault());
    on(list, 'click', (event) => {
      const target = event.target;
      if (target.closest?.('[data-clear-history]')) {
        memory.clear();
        update();
        return;
      }
      const forget = target.closest?.('[data-forget]');
      if (forget) {
        const item = items[Number(forget.dataset.forget)];
        if (item) memory.forget(item);
        update();
        return;
      }
      const row = target.closest?.('[data-index]');
      if (row) choose(Number(row.dataset.index));
    });
    on(input, 'input', () => {
      if (input.dataset.label && input.value.trim() !== input.dataset.label)
        setChosen(input, null);
      update();
    });
    on(input, 'focus', update);
    on(input, 'blur', () =>
      setTimeout(() => {
        if (doc.activeElement !== input) close();
      }, 120),
    );
    return { onKey, close };
  }

  // --- Wiring ----------------------------------------------------------------
  function openPanel(open) {
    panel.hidden = !open;
    el.toggle.setAttribute('aria-expanded', String(open));
    el.toggle.classList.toggle('active', open);
    if (open && !navigating) el.to.focus();
  }

  const listeners = [];
  const on = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    listeners.push(() => target.removeEventListener(type, fn, options));
  };
  const suggest = {
    from: createSuggest(el.from, el.fromSuggest, 'from'),
    to: createSuggest(el.to, el.toSuggest, 'to'),
  };
  on(el.locate, 'click', () => void locate());
  on(el.toggle, 'click', () => openPanel(panel.hidden));
  on(el.close, 'click', () => openPanel(false));
  on(el.fromMe, 'click', () => {
    el.from.value = MY_LOCATION_LABEL;
    setChosen(el.from, null);
    el.to.focus();
  });
  on(el.swap, 'click', () => {
    const from = { value: el.from.value, chosen: chosenPlace(el.from) };
    const to = { value: el.to.value, chosen: chosenPlace(el.to) };
    for (const [input, side] of [
      [el.from, to],
      [el.to, from],
    ]) {
      input.value = side.value;
      setChosen(input, side.chosen);
    }
    if (!String(el.from.value).trim()) el.from.value = MY_LOCATION_LABEL;
    if (isMyLocation(el.to.value)) el.to.value = '';
  });
  on(el.from, 'focus', () => {
    if (el.from.value === MY_LOCATION_LABEL) el.from.select();
  });
  on(el.modes, 'click', (event) => {
    const chip = event.target.closest?.('[data-mode]');
    if (!chip || chip.dataset.mode === mode) return;
    mode = chip.dataset.mode;
    syncModes();
    // The layer reroutes for the new mode when both ends are placed.
    if (route || directions()?.getRoute?.()?.b)
      directions()?.setParams?.({ mode });
  });
  on(el.route, 'click', () => void planRoute());
  for (const [input, kind] of [
    [el.from, 'from'],
    [el.to, 'to'],
  ])
    on(input, 'keydown', (event) => {
      event.stopPropagation(); // keep app shortcuts (1–7, Q–T…) out of typing
      if (suggest[kind].onKey(event)) {
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter') {
        suggest[kind].close();
        void planRoute();
      }
    });
  on(el.start, 'click', startNavigation);
  on(el.stop, 'click', () => {
    el.stop.textContent = '■ STOP';
    stopNavigation();
    el.live.hidden = true;
    el.form.hidden = false;
  });
  on(el.clear, 'click', clearRoute);
  on(el.recenter, 'click', () => {
    followPaused = false;
    el.recenter.hidden = true;
    if (lastFix) updateLive(lastFix);
  });
  on(el.voice, 'click', () => {
    voiceOn = !voiceOn;
    el.voice.setAttribute('aria-pressed', String(voiceOn));
    el.voice.textContent = voiceOn ? '🔊 VOICE' : '🔇 VOICE';
    if (voiceOn) speak('Voice guidance on');
  });
  // Grabbing the globe while navigating pauses the chase camera.
  const canvas = viewer?.scene?.canvas;
  if (canvas) {
    on(canvas, 'pointerdown', pauseFollow, { passive: true });
    on(canvas, 'wheel', pauseFollow, { passive: true });
  }
  on(doc, 'visibilitychange', () => {
    if (navigating && doc.visibilityState === 'visible' && !wakeLock)
      void holdWakeLock();
  });

  return {
    locate,
    destroy() {
      destroyed = true;
      stopNavigation({ quiet: true });
      unsubscribeRoute?.();
      for (const off of listeners) off();
      removeMarker();
      fabs.remove();
      panel.remove();
    },
  };
}
