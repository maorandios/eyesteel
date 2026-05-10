import * as THREE from "three";
import type { ViewModeId } from "@/lib/viewer/view-mode-presets";

/** Guards flat exports / degenerate IFC boxes—framing stays numerical without blowing up extents. */
const MIN_CONTENT_HALF_METERS = 2e-4;

/**
 * Pick a canonical orthographic view axis from a world-aligned AABB.
 * Thin dimension → camera looks along that axis (plate “face”).
 * Dominant elongated axis → perpendicular view (beam/column profile).
 */
export function pickInspectionViewModeFromBox(box: THREE.Box3): ViewModeId {
  if (box.isEmpty()) return "front";

  const size = box.getSize(new THREE.Vector3());
  const ax = Math.abs(size.x);
  const ay = Math.abs(size.y);
  const az = Math.abs(size.z);

  type AxisTag = "x" | "y" | "z";
  const axes: { k: AxisTag; v: number }[] = [
    { k: "x", v: ax },
    { k: "y", v: ay },
    { k: "z", v: az },
  ];
  axes.sort((a, b) => b.v - a.v);

  const [, , thin] = axes;
  const thinnest = thin?.v ?? az;
  const largest = axes[0]?.v ?? Math.max(ax, ay, az, 1e-9);
  const thinRatio = thinnest / largest;

  if (thinRatio < 0.28) {
    if (thin.k === "y") return "top";
    if (thin.k === "x") return "right";
    return "front";
  }

  const long = axes[0]?.k ?? "z";
  if (long === "x") return "front";
  if (long === "z") return "right";
  return "front";
}

/**
 * World AABB half-extents projected onto the canonical orthographic view axes used by eyeSteel
 * (see view-mode-presets `cameraUpForViewMode` / eye direction). Matches how `OrthographicCamera` maps
 * `left/right` to horizontal and `bottom/top` to vertical on screen after look-at.
 *
 * Horizontal = camera local **+X‑ish** extent in world metres; vertical = **+Y‑ish** in view plane.
 */
export function orthoContentHalfExtentsForViewMode(
  mode: ViewModeId,
  size: THREE.Vector3,
): { horizontal: number; vertical: number } {
  const sx = Math.max(Math.abs(size.x) * 0.5, MIN_CONTENT_HALF_METERS);
  const sy = Math.max(Math.abs(size.y) * 0.5, MIN_CONTENT_HALF_METERS);
  const sz = Math.max(Math.abs(size.z) * 0.5, MIN_CONTENT_HALF_METERS);
  switch (mode) {
    case "front":
    case "back":
      return { horizontal: sx, vertical: sy };
    case "top":
    case "bottom":
      return { horizontal: sx, vertical: sz };
    case "right":
    case "left":
      return { horizontal: sz, vertical: sy };
    default:
      return { horizontal: sx, vertical: sy };
  }
}

/**
 * Grow symmetric orthographic half-width / half-height (world units) so the canvas aspect ratio matches
 * the viewport **and** fully contains padded content extents (centered framing).
 *
 * viewportAspect = width / height (>0).
 */
const worldBoxCorners = (box: THREE.Box3): THREE.Vector3[] => {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
};

/**
 * Half-extents of {@link THREE.Box3} on the orthographic camera's local **X/Y** axes (viewport
 * plane), relative to bbox center — matches Clip space framing after `OrthographicCamera` pose is final.
 */
export function boundingBoxHalfExtentsInOrthoCameraPlane(
  camera: THREE.OrthographicCamera,
  box: THREE.Box3,
): { halfX: number; halfY: number } {
  camera.updateMatrixWorld(true);
  const inv = camera.matrixWorldInverse;
  const center = box.getCenter(new THREE.Vector3());
  const cCam = center.clone().applyMatrix4(inv);

  let halfX = MIN_CONTENT_HALF_METERS;
  let halfY = MIN_CONTENT_HALF_METERS;
  for (const cw of worldBoxCorners(box)) {
    const pCam = cw.clone().applyMatrix4(inv);
    halfX = Math.max(halfX, Math.abs(pCam.x - cCam.x));
    halfY = Math.max(halfY, Math.abs(pCam.y - cCam.y));
  }
  return { halfX, halfY };
}

export function fitOrthoSymmetricFrustum(
  contentHalfHorizontal: number,
  contentHalfVertical: number,
  viewportAspect: number,
  marginMultiplier: number,
): { halfWidth: number; halfHeight: number } {
  const safeAspect =
    viewportAspect > 0 && Number.isFinite(viewportAspect) ? viewportAspect : 1;
  const ch = Math.max(contentHalfHorizontal * marginMultiplier, MIN_CONTENT_HALF_METERS);
  const cv = Math.max(contentHalfVertical * marginMultiplier, MIN_CONTENT_HALF_METERS);

  /** Need halfW/halfH with halfW/halfH === safeAspect covering ch×cv centered rect. */
  let halfWidth: number;
  let halfHeight: number;
  if (ch / cv >= safeAspect) {
    halfWidth = ch;
    halfHeight = ch / safeAspect;
  } else {
    halfHeight = cv;
    halfWidth = cv * safeAspect;
  }

  return { halfWidth, halfHeight };
}

