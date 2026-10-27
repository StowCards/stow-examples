// Copyright 2026 Stow Cards
// SPDX-License-Identifier: Apache-2.0

/**
 * Encode one URL path segment from a caller-supplied identifier.
 *
 * Rejects empty values and the dot segments `.` and `..`, which URL
 * normalisation would otherwise resolve into a different endpoint.
 *
 * @internal
 */
export function segment(name: string, value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  if (value === '.' || value === '..') {
    throw new TypeError(`${name} is not a valid identifier.`);
  }
  return encodeURIComponent(value);
}
