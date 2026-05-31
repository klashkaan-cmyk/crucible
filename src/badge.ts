/**
 * Shields.io endpoint badge. `crucible run --badge <file>` writes a JSON file in
 * the shields.io "endpoint" schema; point a shields URL at the raw file to get a
 * live `crucible | 12/12 passing` badge in a README.
 *
 * Schema: https://shields.io/badges/endpoint-badge
 */

import type { ScenarioResult } from "./types.js";

export interface BadgeEndpoint {
  readonly schemaVersion: 1;
  readonly label: string;
  readonly message: string;
  readonly color: string;
}

/**
 * Build the shields.io endpoint payload from suite results.
 *   all gates pass            -> green   "N/N passing"
 *   some fail                 -> red     "P/N passing"
 *   no scenarios              -> lightgrey "no scenarios"
 */
export function badgeEndpoint(
  results: ReadonlyArray<ScenarioResult>,
  label = "crucible",
): BadgeEndpoint {
  const total = results.length;
  if (total === 0) {
    return { schemaVersion: 1, label, message: "no scenarios", color: "lightgrey" };
  }
  const passed = results.filter((r) => r.gatePassed).length;
  const color = passed === total ? "brightgreen" : "red";
  return { schemaVersion: 1, label, message: `${passed}/${total} passing`, color };
}
