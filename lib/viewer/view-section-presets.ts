import * as THREE from "three";

/**
 * Viewer axes after `@thatopen/fragments` IFC import: placements premultiply **RX(-90°)**, so IFC **Z**
 * becomes world **+Y** — match **Three.js Y‑up** (`scene.up`). Floor plane is **XZ**.
 */
export type ViewSectionPresetId =
  | "top"
  | "bottom"
  | "right"
  | "left"
  | "front"
  | "back";

/** Bottom-panel grid order for fixed מבט directions. */
export const VIEW_SECTION_PRESETS_ORDER: ViewSectionPresetId[] = [
  "top",
  "bottom",
  "right",
  "left",
  "front",
  "back",
];

export const VIEW_SECTION_LABELS_HE: Record<ViewSectionPresetId | "free", string> = {
  top: "על",
  bottom: "תחתית",
  right: "ימין",
  left: "שמאל",
  front: "קדימה",
  back: "אחורה",
  free: "חתך חופשי",
};

/** Camera sits along this direction from model center (world units). */
export function cameraOffsetDirection(preset: ViewSectionPresetId): THREE.Vector3 {
  switch (preset) {
    case "top":
      return new THREE.Vector3(0, 1, 0);
    case "bottom":
      return new THREE.Vector3(0, -1, 0);
    case "right":
      return new THREE.Vector3(1, 0, 0);
    case "left":
      return new THREE.Vector3(-1, 0, 0);
    case "front":
      return new THREE.Vector3(0, 0, 1);
    case "back":
      return new THREE.Vector3(0, 0, -1);
    default:
      return new THREE.Vector3(1, 1, 1).normalize();
  }
}

/**
 * Clipping normal (half-space removed is opposite to typical camera-forward for ortho views).
 * Example: top (camera +Y) uses clip normal −Y.
 */
export function clippingNormalForPreset(preset: ViewSectionPresetId): THREE.Vector3 {
  switch (preset) {
    case "top":
      return new THREE.Vector3(0, -1, 0);
    case "bottom":
      return new THREE.Vector3(0, 1, 0);
    case "right":
      return new THREE.Vector3(-1, 0, 0);
    case "left":
      return new THREE.Vector3(1, 0, 0);
    case "front":
      return new THREE.Vector3(0, 0, -1);
    case "back":
      return new THREE.Vector3(0, 0, 1);
    default:
      return new THREE.Vector3(0, -1, 0);
  }
}

/**
 * Stable camera roll for axis-aligned cuts (Y‑up world).
 */
export function cameraUpForPreset(preset: ViewSectionPresetId): THREE.Vector3 {
  switch (preset) {
    case "top":
    case "bottom":
      return new THREE.Vector3(0, 0, 1);
    case "front":
    case "back":
    case "right":
    case "left":
      return new THREE.Vector3(0, 1, 0);
    default:
      return new THREE.Vector3(0, 1, 0);
  }
}
