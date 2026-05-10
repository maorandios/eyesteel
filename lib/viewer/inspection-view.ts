import * as THREE from "three";
import type { ViewModeId } from "@/lib/viewer/view-mode-presets";

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
