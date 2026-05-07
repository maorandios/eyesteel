"use client";

import * as THREE from "three";
import * as FRAGS from "@thatopen/fragments";
import * as OBC from "@thatopen/components";
import type { DimensionLine } from "@thatopen/components-front";
import * as OBF from "@thatopen/components-front";
import { MeasurementHtmlOverlay, hideThatOpenDimensionCss2d } from "@/lib/viewer/measurement/measurement-html-overlay";

type Css2dMarkLike = {
  visible: boolean;
  three: { element: unknown };
};

/** Dark gray for dimension line + badge (That Open `linesMaterial` + HTML overlay). */
const MEASUREMENT_DIM_GRAY = 0x404040;

function createHiddenMeasurementEndpointElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("data-eyeSteel-measurement-endpoint", "true");
  el.style.cssText =
    "box-sizing:border-box;width:0;height:0;margin:0;padding:0;border:0;" +
    "opacity:0;visibility:hidden;pointer-events:none;overflow:hidden;";
  return el;
}

/**
 * Thin wrapper around That Open {@link OBF.LengthMeasurement}.
 * Keeps configuration out of {@link ViewerEngine} and avoids coupling to selection.
 */
export class MeasurementController {
  private measurer: OBF.LengthMeasurement | null = null;
  private configured = false;
  private attachedWorld: OBC.World | null = null;
  private htmlOverlay: MeasurementHtmlOverlay | null = null;
  private tapCommitChain = Promise.resolve();

  constructor(private readonly components: OBC.Components) {}

  private ensure(): OBF.LengthMeasurement {
    if (!this.measurer) {
      this.measurer = this.components.get(OBF.LengthMeasurement);
    }
    const m = this.measurer;
    if (!this.configured) {
      m.mode = "free";
      /** LINE + POINT + FACE matches That Open defaults — POINT-only can miss picks on some IFC tessellation. */
      m.snappings = [
        FRAGS.SnappingClass.LINE,
        FRAGS.SnappingClass.POINT,
        FRAGS.SnappingClass.FACE,
      ];
      m.units = "mm";
      m.rounding = 1;
      m.color = new THREE.Color(MEASUREMENT_DIM_GRAY);
      m.linesEndpointElement = createHiddenMeasurementEndpointElement();
      // pickMode / delay / pickerSize — set in activate() via applyMeasurementPickProfile (desktop vs touch).
      // Do not set `enabled` / `visible` here: Measurement.setEvents requires world first.
      this.configured = true;
    }
    return m;
  }

  /** Assign world before activate (same instance as the IFC viewer). */
  attach(world: OBC.World) {
    const m = this.ensure();
    m.world = world;
    m.visible = false;
    m.enabled = false;
    this.attachedWorld = world;
    const parent = world.renderer?.three?.domElement?.parentElement;
    if (parent instanceof HTMLElement) {
      this.htmlOverlay?.dispose();
      this.htmlOverlay = new MeasurementHtmlOverlay(parent);
    }
  }

  /**
   * Hide the library snap marker (CSS2D dot). Run every frame — when measurement mode is off the
   * picker can still leave the last marker visible (offset/glitched vs our DOM overlay).
   */
  suppressVertexPickerMarker() {
    if (!this.measurer) return;
    const picker = (
      this.measurer as unknown as {
        _vertexPicker?: { marker?: Css2dMarkLike | null };
      }
    )._vertexPicker;
    const marker = picker?.marker;
    if (!marker) return;
    marker.visible = false;
    const el = marker.three.element;
    if (el instanceof HTMLElement) {
      el.style.display = "none";
      el.style.visibility = "hidden";
      el.style.opacity = "0";
      el.style.pointerEvents = "none";
    }
  }

  /** In-progress segment uses the same CSS2D endpoints/label as committed lines. */
  private hidePreviewDimensionCss2d() {
    const dim = (this.measurer as unknown as { _temp?: { dimension?: DimensionLine } })._temp
      ?.dimension;
    if (dim) hideThatOpenDimensionCss2d(dim);
  }

  /** Call each frame after render so HTML badges track the camera (CSS2D labels stay hidden). */
  syncHtmlLabels() {
    if (!this.measurer || !this.attachedWorld?.renderer?.three?.domElement) return;
    this.suppressVertexPickerMarker();
    this.hidePreviewDimensionCss2d();
    const canvas = this.attachedWorld.renderer.three.domElement;
    const camera = this.attachedWorld.camera?.three;
    if (!camera || !this.htmlOverlay) return;
    const preview = (this.measurer as unknown as { _temp?: { dimension?: DimensionLine } })._temp
      ?.dimension;
    const lines = preview ? [...this.measurer.lines, preview] : this.measurer.lines;
    this.htmlOverlay.sync(lines, camera, canvas);
  }

  /**
   * Coarse pointer / pure touch UIs: tighter GPU pick kernel + pick-on-stop so huge IFCs stay smooth.
   * Mouse + hover (desktop): MOUSE_MOVE matches stock That Open behaviour (snappy line preview).
   */
  /** Used by {@link ViewerEngine} for orbit suppression vs measurement instant taps. */
  static prefersTouchLikeMeasurement(): boolean {
    if (typeof window === "undefined") return false;
    if (window.matchMedia("(pointer: coarse)").matches) return true;
    if (
      typeof navigator !== "undefined" &&
      navigator.maxTouchPoints > 0 &&
      window.matchMedia("(hover: none)").matches
    ) {
      return true;
    }
    return false;
  }

  private static applyMeasurementPickProfile(m: OBF.LengthMeasurement, touchLike: boolean) {
    if (touchLike) {
      m.pickMode = OBF.MeasurementPickMode.MOUSE_STOP;
      m.delay = 280;
      /** Library default is 6px; we had raised this to 14 which reads as a wide snap on finger taps. */
      m.pickerSize = 6;
    } else {
      m.pickMode = OBF.MeasurementPickMode.MOUSE_MOVE;
      m.delay = 140;
      m.pickerSize = 12;
    }
  }

  activate() {
    const m = this.ensure();
    MeasurementController.applyMeasurementPickProfile(
      m,
      MeasurementController.prefersTouchLikeMeasurement(),
    );
    m.visible = true;
    m.enabled = true;
  }

  deactivate() {
    if (!this.measurer) return;
    this.measurer.cancelCreation();
    this.measurer.enabled = false;
  }

  /**
   * Two taps => two {@link OBF.LengthMeasurement.create} calls complete one segment (library contract).
   *
   * That Open's raycaster mouse helper only follows `pointermove` / `touchstart`, not `pointerdown`.
   * A tap without movement leaves `lastPick` / internal mouse stale, so the first point often misses snap.
   * We prime `lastPick` with an explicit snapped ray at the tap NDC before `create()`.
   */
  async tapCommit(ndc: THREE.Vector2) {
    const ndcCopy = ndc.clone();
    this.tapCommitChain = this.tapCommitChain
      .then(() => this.tapCommitInner(ndcCopy))
      .catch((err) => {
        console.error("[measurement] tapCommit failed:", err);
      });
    await this.tapCommitChain;
  }

  private async tapCommitInner(ndc: THREE.Vector2) {
    const m = this.ensure();
    if (!m.enabled || !this.attachedWorld) return;

    /* GPU picks read render buffers — one painted frame + needsUpdate avoids stale/empty reads on mobile WebGL. */
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const rendererLike = this.attachedWorld.renderer as {
      needsUpdate?: boolean;
      update?: () => void;
    };
    if (rendererLike && typeof rendererLike.needsUpdate === "boolean") {
      rendererLike.needsUpdate = true;
      rendererLike.update?.();
    }

    const raycaster = this.components.get(OBC.Raycasters).get(this.attachedWorld);
    const fresh = await raycaster.castRay({
      snappingClasses: m.snappings,
      position: ndc,
    });
    type FragSnapHit = typeof fresh & {
      snappedEdgeP1?: THREE.Vector3;
      snappedEdgeP2?: THREE.Vector3;
    };

    (m as unknown as { lastPick: typeof fresh }).lastPick = fresh;

    /* Second tap runs `create()` → `endCreation()` without `pointermove`, so `_temp.line.end`
     * stays on the first point unless we mirror {@link OBF.LengthMeasurement}'s `updatePreviewLine`. */
    const temp = (m as unknown as {
      _temp: {
        isDragging: boolean;
        line: { start: THREE.Vector3; end: THREE.Vector3 };
        dimension?: DimensionLine & { start: THREE.Vector3; end: THREE.Vector3; visible?: boolean };
      };
    })._temp;

    if (temp?.isDragging && temp.dimension) {
      if (m.mode === "free" && fresh?.point) {
        temp.line.end.copy(fresh.point);
        temp.dimension.end = temp.line.end;
      } else if (m.mode === "edge") {
        const snapHit = fresh as FragSnapHit;
        const p1 = snapHit?.snappedEdgeP1;
        const p2 = snapHit?.snappedEdgeP2;
        if (p1 && p2) {
          temp.line.start.copy(p1);
          temp.line.end.copy(p2);
          temp.dimension.start = temp.line.start;
          temp.dimension.end = temp.line.end;
          temp.dimension.visible = true;
        }
      }
    }

    await m.create();

    this.attachedWorld.renderer?.update?.();
  }

  clearAll() {
    if (!this.measurer) return;
    this.measurer.cancelCreation();
    this.measurer.list.clear();
    this.htmlOverlay?.clearDom();
  }

  /**
   * Disable measurement when disposing the viewer. Do not dispose the singleton
   * returned by {@link OBC.Components.get}(LengthMeasurement).
   */
  shutdown() {
    this.htmlOverlay?.dispose();
    this.htmlOverlay = null;
    this.attachedWorld = null;
    if (!this.measurer) return;
    this.measurer.cancelCreation();
    this.measurer.enabled = false;
    this.measurer.visible = false;
    this.measurer.world = null;
  }
}
