"use client";

import * as THREE from "three";
import * as FRAGS from "@thatopen/fragments";
import * as OBC from "@thatopen/components";
import { useViewSectionStore } from "@/lib/state/view-section-store";
import { worldPointFromSnapHit, type SnapRayHit } from "@/lib/viewer/measurement/smart-measure-math";
import {
  VIEW_SECTION_LABELS_HE,
  cameraOffsetDirection,
  cameraUpForPreset,
  clippingNormalForPreset,
  type ViewSectionPresetId,
} from "@/lib/viewer/view-section-presets";

const MARKER_RADIUS_RATIO = 0.0035;

/** Same snapping profile as smart measure — reliable on fragment meshes. */
const SECTION_SNAPS: FRAGS.SnappingClass[] = [
  FRAGS.SnappingClass.LINE,
  FRAGS.SnappingClass.POINT,
  FRAGS.SnappingClass.FACE,
];

export class ViewSectionController {
  private readonly components: OBC.Components;
  private world: OBC.World | null = null;
  private clipper: OBC.Clipper | null = null;
  private clipperPrimed = false;

  private activePlaneId: string | null = null;

  private readonly baseNormal = new THREE.Vector3(0, -1, 0);
  private readonly basePoint = new THREE.Vector3();
  private depthOffset = 0;
  private flipped = false;
  private depthExtent = 10;

  /** Saved before tightening FOV for מבט — restored on cancel / dispose. */
  private savedPerspectiveFov: number | null = null;

  private activePreset: ViewSectionPresetId | null = null;

  private freeA: THREE.Vector3 | null = null;
  private freeB: THREE.Vector3 | null = null;

  private helperRoot: THREE.Group | null = null;
  private markerMaterial: THREE.MeshBasicMaterial | null = null;
  private readonly markerMeshes: THREE.Mesh[] = [];
  private cutLine: THREE.Line | null = null;

  constructor(components: OBC.Components) {
    this.components = components;
  }

  attach(world: OBC.World) {
    this.world = world;
    this.ensureClipper();
    if (!this.helperRoot) {
      this.helperRoot = new THREE.Group();
      this.helperRoot.name = "eyeSteel-free-section-helpers";
      world.scene.three.add(this.helperRoot);
    }
  }

  private ensureClipper() {
    if (this.clipperPrimed) return;
    this.clipper = this.components.get(OBC.Clipper);
    /**
     * Global clipping keeps planes on {@link OBC.BaseRenderer.three}.clippingPlanes — the path
     * documented for wiring fragment models via `getClippingPlanesEvent`. Local-only planes stay off
     * `WebGLRenderer.clippingPlanes`, so the worker often saw no cuts before our listener/throttle fix.
     */
    this.clipper.localClippingPlanes = false;
    this.clipper.setup();
    this.clipperPrimed = true;
  }

  private propagateClipperToRenderer() {
    if (!this.clipper) return;
    const clipperSync = this.clipper as unknown as { updateMaterialsAndPlanes(): void };
    clipperSync.updateMaterialsAndPlanes();
    const fm = this.components.get(OBC.FragmentsManager);
    if (fm.initialized) void fm.core.update(true);
  }

  private narrowCameraForSectionView() {
    const cam = this.world?.camera.three;
    if (!cam || !(cam instanceof THREE.PerspectiveCamera)) return;
    if (this.savedPerspectiveFov === null) this.savedPerspectiveFov = cam.fov;
    cam.fov = 22;
    cam.updateProjectionMatrix();
  }

  private restoreCameraFov() {
    const cam = this.world?.camera.three;
    if (!cam || !(cam instanceof THREE.PerspectiveCamera)) return;
    if (this.savedPerspectiveFov !== null) {
      cam.fov = this.savedPerspectiveFov;
      cam.updateProjectionMatrix();
      this.savedPerspectiveFov = null;
    }
  }

  private markerRadius() {
    return Math.max(this.depthExtent * MARKER_RADIUS_RATIO, 0.04);
  }

  private ensureMarkerMaterial() {
    if (!this.markerMaterial) {
      this.markerMaterial = new THREE.MeshBasicMaterial({
        color: 0xf97316,
        depthTest: true,
      });
    }
    return this.markerMaterial;
  }

  private syncStoreSectionUi() {
    type Mode =
      | "none"
      | "top"
      | "bottom"
      | "right"
      | "left"
      | "front"
      | "back"
      | "free";
    let activeViewMode: Mode = "none";
    if (this.activePreset) activeViewMode = this.activePreset;
    else if (this.activePlaneId && this.freeB) activeViewMode = "free";

    const sectionLabel =
      this.activePreset != null
        ? VIEW_SECTION_LABELS_HE[this.activePreset]
        : this.freeB
          ? VIEW_SECTION_LABELS_HE.free
          : null;

    useViewSectionStore.getState().setSectionUi({
      activeViewMode,
      sectionActive: this.activePlaneId != null,
      sectionType: this.activePreset ? "fixed" : this.freeB ? "free" : null,
      sectionLabel,
      depthOffset: this.depthOffset,
      depthExtent: this.depthExtent,
      flipped: this.flipped,
    });
  }

  private clearCutLine() {
    if (this.cutLine && this.helperRoot) {
      this.helperRoot.remove(this.cutLine);
      const g = this.cutLine.geometry;
      const m = this.cutLine.material;
      g.dispose();
      (m as THREE.Material).dispose();
      this.cutLine = null;
    }
  }

  private clearMarkers() {
    if (!this.helperRoot) return;
    for (const m of this.markerMeshes) {
      this.helperRoot.remove(m);
      m.geometry.dispose();
    }
    this.markerMeshes.length = 0;
    this.clearCutLine();
  }

  private addMarker(p: THREE.Vector3) {
    if (!this.helperRoot) return;
    const geom = new THREE.SphereGeometry(this.markerRadius(), 16, 12);
    const mesh = new THREE.Mesh(geom, this.ensureMarkerMaterial());
    mesh.position.copy(p);
    this.helperRoot.add(mesh);
    this.markerMeshes.push(mesh);
  }

  private drawCutLine(a: THREE.Vector3, b: THREE.Vector3) {
    this.clearCutLine();
    if (!this.helperRoot) return;
    const geom = new THREE.BufferGeometry().setFromPoints([a.clone(), b.clone()]);
    const mat = new THREE.LineBasicMaterial({ color: 0xf97316, linewidth: 1 });
    this.cutLine = new THREE.Line(geom, mat);
    this.helperRoot.add(this.cutLine);
  }

  private getSimplePlane(id: string) {
    if (!this.clipper) return undefined;
    for (const [pid, plane] of this.clipper.list) {
      if (pid === id) return plane;
    }
    return undefined;
  }

  /** Creates one Clipper plane; removes any previous plane managed here. */
  private createPlane(normal: THREE.Vector3, point: THREE.Vector3) {
    if (!this.world || !this.clipper) return null;
    this.ensureClipper();
    this.clipper.deleteAll();
    this.activePlaneId = null;

    const n = normal.clone().normalize();
    const p = point.clone();
    const id = this.clipper.createFromNormalAndCoplanarPoint(this.world, n, p);
    this.activePlaneId = id;

    const plane = this.getSimplePlane(id);
    if (plane) {
      plane.visible = false;
      plane.autoScale = false;
    }

    this.propagateClipperToRenderer();
    return id;
  }

  private effectiveNormal(target: THREE.Vector3) {
    target.copy(this.baseNormal).normalize();
    if (this.flipped) target.negate();
  }

  private refreshPlaneGeometry() {
    if (!this.activePlaneId || !this.clipper || !this.world) return;
    const plane = this.getSimplePlane(this.activePlaneId);
    if (!plane) return;

    const en = new THREE.Vector3();
    this.effectiveNormal(en);
    const pt = this.basePoint.clone().addScaledVector(en, this.depthOffset);
    plane.setFromNormalAndCoplanarPoint(en, pt);
    this.propagateClipperToRenderer();
  }

  applyPreset(preset: ViewSectionPresetId, modelRoot: THREE.Object3D) {
    if (!this.world) return;

    this.clearMarkers();
    this.freeA = null;
    this.freeB = null;

    this.activePreset = preset;
    this.flipped = false;
    this.depthOffset = 0;

    const box = new THREE.Box3().setFromObject(modelRoot);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 1);
    this.depthExtent = extent;

    this.basePoint.copy(center);

    const cn = clippingNormalForPreset(preset);
    this.baseNormal.copy(cn);

    const en = new THREE.Vector3();
    this.effectiveNormal(en);
    this.createPlane(en, center.clone());

    const camDir = cameraOffsetDirection(preset);
    const dist = extent * 1.65;
    const eye = center.clone().addScaledVector(camDir, dist);
    const ctrl = this.world.camera.controls;
    const cam = this.world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    cam.up.copy(cameraUpForPreset(preset));
    ctrl?.updateCameraUp();
    ctrl?.setOrbitPoint(center.x, center.y, center.z);
    ctrl?.setLookAt(eye.x, eye.y, eye.z, center.x, center.y, center.z, false);

    useViewSectionStore.getState().setFreePick("idle", null, null);
    this.narrowCameraForSectionView();
    this.syncStoreSectionUi();
  }

  /** Clears clipping + visuals; frees pick flow. */
  cancelSection() {
    this.restoreCameraFov();
    if (this.world && this.clipper) {
      this.clipper.deleteAll();
    }
    this.activePlaneId = null;
    this.activePreset = null;
    this.freeA = null;
    this.freeB = null;
    this.depthOffset = 0;
    this.flipped = false;
    this.clearMarkers();
    useViewSectionStore.getState().setFreePick("idle", null, null);
    useViewSectionStore.getState().resetUi();
    this.propagateClipperToRenderer();
  }

  beginFreePick(modelRoot: THREE.Object3D) {
    if (!this.world) return;

    if (this.world && this.clipper) {
      this.clipper.deleteAll();
      this.propagateClipperToRenderer();
    }
    this.restoreCameraFov();
    this.activePlaneId = null;
    this.activePreset = null;
    this.flipped = false;
    this.depthOffset = 0;
    this.freeA = null;
    this.freeB = null;
    this.clearMarkers();

    const box = new THREE.Box3().setFromObject(modelRoot);
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 1);
    this.depthExtent = extent;

    useViewSectionStore.getState().setSectionUi({
      activeViewMode: "free",
      sectionActive: false,
      sectionType: null,
      sectionLabel: null,
      depthOffset: 0,
      depthExtent: extent,
      flipped: false,
    });
    useViewSectionStore.getState().setFreePick(
      "pick-first",
      "בחר נקודה ראשונה על המודל",
      null,
    );
  }

  abortFreePick() {
    this.freeA = null;
    this.freeB = null;
    this.clearMarkers();
    useViewSectionStore.getState().setFreePick("idle", null, null);
    if (!this.activePlaneId) {
      useViewSectionStore.getState().resetUi();
    } else {
      this.syncStoreSectionUi();
    }
  }

  setDepthOffset(offset: number) {
    const max = this.depthExtent;
    this.depthOffset = THREE.MathUtils.clamp(offset, -max, max);
    this.refreshPlaneGeometry();
    this.syncStoreSectionUi();
  }

  flip() {
    if (!this.activePlaneId) return;
    this.flipped = !this.flipped;
    this.refreshPlaneGeometry();
    this.syncStoreSectionUi();
  }

  /** Uses fragment raycast + full view refresh (same pattern as smart measure). */
  async tryPick(ndc: THREE.Vector2): Promise<void> {
    const step = useViewSectionStore.getState().freePickStep;
    if (step !== "pick-first" && step !== "pick-second") return;
    if (!this.world) return;

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const rendererLike = this.world.renderer as { needsUpdate?: boolean; update?: () => void };
    if (rendererLike && typeof rendererLike.needsUpdate === "boolean") {
      rendererLike.needsUpdate = true;
      rendererLike.update?.();
    }

    const raycaster = this.components.get(OBC.Raycasters).get(this.world);
    let hit = await raycaster.castRay({
      snappingClasses: SECTION_SNAPS,
      position: ndc.clone(),
    });
    if (!hit) {
      hit = await raycaster.castRay({ position: ndc.clone() });
    }

    const pHit = hit ? worldPointFromSnapHit(hit as SnapRayHit) : null;
    if (!pHit) {
      useViewSectionStore.getState().setFreePick(
        step,
        step === "pick-first"
          ? "בחר נקודה ראשונה על המודל"
          : "בחר נקודה שנייה ליצירת קו חתך",
        "לא נמצא מיקום על המודל — לחץ ישירות על הפלדה.",
      );
      return;
    }

    const p = pHit.clone();

    if (step === "pick-first") {
      this.freeA = p;
      this.clearMarkers();
      this.addMarker(p);
      useViewSectionStore.getState().setFreePick(
        "pick-second",
        "בחר נקודה שנייה ליצירת קו חתך",
        null,
      );
      return;
    }

    if (step === "pick-second" && this.freeA) {
      const a = this.freeA;
      const b = p;
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      const epsLen = Math.max(this.depthExtent * 1e-5, 1e-4);
      if (len < epsLen) {
        useViewSectionStore.getState().setFreePick(
          "pick-second",
          "בחר נקודה שנייה ליצירת קו חתך",
          "הנקודות קרובות מדי — בחר מחדש.",
        );
        return;
      }
      dir.multiplyScalar(1 / len);

      const rawUp = this.world.scene.three.up;
      const up =
        rawUp.lengthSq() < 1e-12
          ? new THREE.Vector3(0, 1, 0)
          : rawUp.clone().normalize();

      const normal = new THREE.Vector3().crossVectors(dir, up);
      const epsN = Math.max(this.depthExtent * 1e-8, 1e-10);
      if (normal.lengthSq() < epsN * epsN) {
        useViewSectionStore.getState().setFreePick(
          "pick-second",
          "בחר נקודה שנייה ליצירת קו חתך",
          "בחר שתי נקודות רחוקות יותר (קו כמעט מקביל למגזר העליון).",
        );
        return;
      }
      normal.normalize();

      this.freeB = b;
      this.addMarker(b);
      this.drawCutLine(a, b);

      this.activePreset = null;
      this.flipped = false;
      this.depthOffset = 0;

      this.baseNormal.copy(normal);
      const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
      this.basePoint.copy(mid);

      const en = new THREE.Vector3();
      this.effectiveNormal(en);
      this.createPlane(en, a.clone());

      this.narrowCameraForSectionView();
      useViewSectionStore.getState().setFreePick("active", null, null);
      this.syncStoreSectionUi();
    }
  }

  clearForNewModel() {
    this.cancelSection();
  }

  dispose() {
    this.restoreCameraFov();
    if (this.world && this.clipper) {
      this.clipper.deleteAll();
    }
    this.activePlaneId = null;

    this.clearMarkers();
    if (this.markerMaterial) {
      this.markerMaterial.dispose();
      this.markerMaterial = null;
    }
    if (this.helperRoot) {
      this.helperRoot.removeFromParent();
      this.helperRoot = null;
    }

    useViewSectionStore.getState().resetUi();
  }
}
