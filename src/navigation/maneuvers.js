/**
 * @module navigation/maneuvers
 * @description The big turn arrow for a route step (OSRM maneuver type and
 * modifier), and speed formatting for the ride readout.
 */

const MODIFIER_ARROWS = Object.freeze({
  uturn: '⤺',
  'sharp left': '↙',
  left: '↰',
  'slight left': '↖',
  straight: '↑',
  'slight right': '↗',
  right: '↱',
  'sharp right': '↘',
});

/**
 * Arrow glyph for a step.
 * @param {{type?: string, modifier?: string|null}|null} step
 * @returns {string}
 */
export function maneuverArrow(step) {
  const type = String(step?.type || '').toLowerCase();
  const modifier = String(step?.modifier || '').toLowerCase();
  if (type === 'arrive') return '🏁';
  if (type.includes('roundabout') || type.includes('rotary')) return '⟳';
  if (type === 'depart' || type === 'continue' || type === 'new name')
    return MODIFIER_ARROWS[modifier] && !modifier.includes('straight')
      ? MODIFIER_ARROWS[modifier]
      : '↑';
  return MODIFIER_ARROWS[modifier] || '↑';
}

/**
 * "32 km/h" from metres per second; empty when unknown.
 * @param {number|null|undefined} speedMps
 * @returns {string}
 */
export function formatSpeedKmh(speedMps) {
  if (!Number.isFinite(speedMps) || speedMps < 0) return '';
  return `${Math.round(speedMps * 3.6)} km/h`;
}
