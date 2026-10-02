// Path validation rules for belt length, incline and curvature.

import { MAX_BELT_LENGTH } from './catalog.js';
import { DEG } from './vec.js';

export const DEFAULT_RULES = {
  maxLength: MAX_BELT_LENGTH, // m
  minLength: 0.5, // m (assumed)
  maxIncline: 35 * DEG, // default maximum incline
  bendRadius: 2.0, // m (assumed)
  curvatureTolerance: 0.9,
};

/** @returns {string[]} human-readable errors; empty = valid */
export function validatePath(path, rules = DEFAULT_RULES) {
  const errs = [];
  if (path.length > rules.maxLength) {
    errs.push(`太長：${path.length.toFixed(1)} m > ${rules.maxLength.toFixed(0)} m`);
  }
  if (path.length < rules.minLength) errs.push(`太短：${path.length.toFixed(2)} m`);
  const inc = path.incline();
  if (inc > rules.maxIncline) {
    errs.push(`太陡：${(inc / DEG).toFixed(1)}° > ${(rules.maxIncline / DEG).toFixed(0)}°`);
  }
  const minR = path.minRadius();
  if (minR < rules.bendRadius * rules.curvatureTolerance) {
    errs.push(`彎太急：最小半徑 ${minR.toFixed(2)} m < ${rules.bendRadius.toFixed(2)} m`);
  }
  return errs;
}
