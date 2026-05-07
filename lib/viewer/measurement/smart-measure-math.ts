import * as THREE from "three";

export type SmartMeasureMetrics = {
  /** Euclidean distance ‖p₂ − p₁‖ (metres). */
  directM: number;
  /** |Δ · û| — magnitude along scene vertical (metres). */
  heightM: number;
  /** Distance orthogonal to scene vertical (metres). */
  horizontalM: number;
  /** Corner between vertical leg and horizontal leg (same XY as p₁ after vertical move toward p₂). */
  corner: THREE.Vector3;
};

/** Metrics relative to {@link THREE.Scene.up} (default Y‑up); horizontal lies in the plane normal to up. */
export function computeSmartMeasureMetrics(
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  worldUp: THREE.Vector3,
): SmartMeasureMetrics {
  const up = worldUp.clone().normalize();
  const delta = new THREE.Vector3().subVectors(p2, p1);
  const along = delta.dot(up);
  const horizontalVec = delta.clone().sub(up.clone().multiplyScalar(along));
  const corner = p1.clone().add(up.clone().multiplyScalar(along));
  return {
    directM: delta.length(),
    heightM: Math.abs(along),
    horizontalM: horizontalVec.length(),
    corner,
  };
}

export type SnapRayHit = THREE.Intersection & {
  snappingClass?: number;
  snappedEdgeP1?: THREE.Vector3;
  snappedEdgeP2?: THREE.Vector3;
};

/**
 * LINE snaps expose segment endpoints — bias toward nearest endpoint when the pick is near an end
 * (edge‑to‑edge); otherwise use the closest point on the edge (`hit.point`).
 */
export function worldPointFromSnapHit(hit: SnapRayHit): THREE.Vector3 | null {
  if (!hit.point) return null;
  const p = hit.point;
  const e1 = hit.snappedEdgeP1;
  const e2 = hit.snappedEdgeP2;
  if (e1 && e2) {
    const edge = new THREE.Vector3().subVectors(e2, e1);
    const len = edge.length();
    if (len > 1e-9) {
      const t = Math.max(0, Math.min(1, new THREE.Vector3().subVectors(p, e1).dot(edge) / (len * len)));
      const distToStart = t * len;
      const distToEnd = (1 - t) * len;
      const endTol = Math.min(len * 0.1, 0.12);
      if (distToStart <= endTol) return e1.clone();
      if (distToEnd <= endTol) return e2.clone();
    }
  }
  return p.clone();
}
