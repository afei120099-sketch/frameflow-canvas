/**
 * Director Stage (导演台) — module identity only, V0.1 infrastructure phase.
 *
 * Deliberately contains no Scene / Prop / SceneState / Camera / Motion / ControlPackage types and
 * no storage: those wait for the confirmed architecture (docs/director-stage/README.md).
 * Nothing in the canvas imports this module yet.
 */

export const DIRECTOR_STAGE_MODULE = {
  id: "director-stage",
  version: "0.1.0",
  phase: "infrastructure",
  /** Not reachable from the canvas UI until the entry point is approved. */
  enabled: false,
} as const;
