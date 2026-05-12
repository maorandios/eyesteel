"use client";

import * as THREE from "three";
import * as FRAGS from "@thatopen/fragments";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import { useSmartMeasureStore } from "@/lib/state/smart-measure-store";
import {
  computeSmartMeasureMetrics,
  worldPointFromSnapHit,
  type SnapRayHit,
} from "@/lib/viewer/measurement/smart-measure-math";
import { SmartMeasureOverlay } from "@/lib/viewer/measurement/smart-measure-overlay";
import type { CompletedSmartSegment } from "@/lib/viewer/measurement/smart-measure-visuals";
import { SmartMeasureVisuals } from "@/lib/viewer/measurement/smart-measure-visuals";

const SNAPS: FRAGS.SnappingClass[] = [
  FRAGS.SnappingClass.LINE,
  FRAGS.SnappingClass.POINT,
  FRAGS.SnappingClass.FACE,
];

/** Silence That Open LengthMeasurement singleton — we use custom smart measure only. */
function silenceLengthMeasurement(m: OBF.LengthMeasurement | null) {
  if (!m) return;
  try {
    m.cancelCreation();
    m.enabled = false;
    m.visible = false;
  } catch {
    /* noop */
  }
}

/**
 * Two‑point smart measurement: direct, vertical (along scene up), and horizontal span.
 * Snapping uses fragment LINE / POINT / FACE via ThatOpen raycast resolution (.vertex‑centric default).
 */
export class MeasurementController {
  private readonly components: OBC.Components;
  private attachedWorld: OBC.World | null = null;
  private overlay: SmartMeasureOverlay | null = null;
  private visuals: SmartMeasureVisuals | null = null;
  private tapCommitChain = Promise.resolve();

  private active = false;
  /** Draft first point waiting for second tap. */
  private draftP1: THREE.Vector3 | null = null;
  /** Hover snap preview while picking. */
  private hoverWorld: THREE.Vector3 | null = null;
  private segments: CompletedSmartSegment[] = [];

  private hoverRaf = 0;
  private unsubBreakdown: (() => void) | null = null;
  private lastBreakdownKey: string | null = null;

  constructor(components: OBC.Components) {
    this.components = components;
  }

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

  attach(world: OBC.World) {
    this.attachedWorld = world;
    silenceLengthMeasurement(this.safeLibraryMeasurer());

    const parent = world.renderer?.three?.domElement?.parentElement;
    if (parent instanceof HTMLElement) {
      this.overlay?.dispose();
      this.overlay = new SmartMeasureOverlay(parent);
    }
    if (!this.visuals) this.visuals = new SmartMeasureVisuals();
    world.scene.three.add(this.visuals.root);
  }

  activate() {
    const world = this.attachedWorld;
    if (!world || !this.visuals || !this.overlay) return;
    this.active = true;
    silenceLengthMeasurement(this.safeLibraryMeasurer());
    this.draftP1 = null;
    this.hoverWorld = null;
    useSmartMeasureStore.getState().setPhase("pickFirst");
    useSmartMeasureStore.getState().setHint("לחץ על נקודה ראשונה על המודל");

    this.unsubBreakdown?.();
    this.lastBreakdownKey = null;
    const syncBreakdown = () => {
      const { detailsSegmentIndex } = useSmartMeasureStore.getState();
      const bd = detailsSegmentIndex;
      const key = `${bd ?? "-"}`;
      if (key === this.lastBreakdownKey) return;
      this.lastBreakdownKey = key;
      if (!this.visuals) return;
      this.visuals.rebuildCompleted(this.segments, bd);
      void this.attachedWorld?.renderer?.update?.();
    };
    this.unsubBreakdown = useSmartMeasureStore.subscribe(syncBreakdown);
    syncBreakdown();
  }

  deactivate() {
    this.active = false;
    this.unsubBreakdown?.();
    this.unsubBreakdown = null;
    this.lastBreakdownKey = null;
    this.cancelHoverRaf();
    this.hoverWorld = null;
    this.visuals?.clearDraft();
    this.overlay?.hideSnap();
    silenceLengthMeasurement(this.safeLibraryMeasurer());
  }

  private safeLibraryMeasurer(): OBF.LengthMeasurement | null {
    try {
      return this.components.get(OBF.LengthMeasurement);
    } catch {
      return null;
    }
  }

  /** Legacy hook — That Open vertex picker unused. */
  suppressVertexPickerMarker() {
    silenceLengthMeasurement(this.safeLibraryMeasurer());
  }

  scheduleHoverPick(ndc: THREE.Vector2) {
    if (!this.active || !this.attachedWorld) return;
    if (this.hoverRaf) return;
    this.hoverRaf = requestAnimationFrame(() => {
      this.hoverRaf = 0;
      void this.runHover(ndc);
    });
  }

  private cancelHoverRaf() {
    if (this.hoverRaf) {
      cancelAnimationFrame(this.hoverRaf);
      this.hoverRaf = 0;
    }
  }

  private async measurePickWorldAsync(ndc: THREE.Vector2): Promise<THREE.Vector3 | null> {
    const world = this.attachedWorld;
    if (!world) return null;

    const rendererLike = world.renderer as { needsUpdate?: boolean; update?: () => void };
    if (rendererLike && typeof rendererLike.needsUpdate === "boolean") {
      rendererLike.needsUpdate = true;
      rendererLike.update?.();
    }

    const raycaster = this.components.get(OBC.Raycasters).get(world);
    try {
      const snapHit = (await raycaster.castRay({
        snappingClasses: SNAPS,
        position: ndc,
      })) as SnapRayHit | null;
      if (snapHit) {
        const w = worldPointFromSnapHit(snapHit);
        if (w) return w;
      }
    } catch {
      /* continue to coarse ray */
    }

    try {
      const coarse = raycaster.castRayToObjects(undefined, ndc);
      if (coarse?.point) return coarse.point.clone();
    } catch {
      /* noop */
    }

    return null;
  }

  private async runHover(ndc: THREE.Vector2) {
    const world = this.attachedWorld;
    if (!world || !this.overlay || !this.active) return;
    try {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const rendererLike = world.renderer as { needsUpdate?: boolean; update?: () => void };
      if (rendererLike && typeof rendererLike.needsUpdate === "boolean") {
        rendererLike.needsUpdate = true;
        rendererLike.update?.();
      }
      this.hoverWorld = await this.measurePickWorldAsync(ndc);

      const canvas = world.renderer?.three?.domElement;
      const camera = world.camera?.three;
      if (camera && canvas) {
        this.overlay.setSnapMarker(canvas, camera, this.hoverWorld);
      }

      if (this.draftP1 && this.hoverWorld && this.visuals) {
        this.visuals.setDraft(this.draftP1, this.hoverWorld);
      } else if (this.visuals) {
        this.visuals.clearDraft();
      }
      void world.renderer?.update?.();
    } catch {
      this.hoverWorld = null;
      this.overlay?.hideSnap();
    }
  }

  syncHtmlLabels() {
    const world = this.attachedWorld;
    if (!world?.renderer?.three?.domElement || !world.camera?.three || !this.overlay) return;

    const canvas = world.renderer.three.domElement;
    const camera = world.camera.three;
    const { detailsSegmentIndex } = useSmartMeasureStore.getState();
    const breakdownFor = detailsSegmentIndex;

    const specs: Array<{
      id: string;
      world: THREE.Vector3;
      meters: number;
      variant: "main" | "break";
      segmentIndex?: number;
    }> = [];

    const onPick =
      this.active && this.segments.length > 0
        ? (idx: number) => {
            useSmartMeasureStore.getState().toggleBreakdownForSegment(idx);
          }
        : undefined;

    this.segments.forEach((seg, i) => {
      const mid = new THREE.Vector3().addVectors(seg.p1, seg.p2).multiplyScalar(0.5);
      specs.push({
        id: `seg-${i}-main`,
        world: mid,
        meters: seg.metrics.directM,
        variant: "main",
        segmentIndex: i,
      });
      if (breakdownFor === i) {
        const midV = new THREE.Vector3().addVectors(seg.p1, seg.metrics.corner).multiplyScalar(0.5);
        const midH = new THREE.Vector3().addVectors(seg.metrics.corner, seg.p2).multiplyScalar(0.5);
        specs.push({
          id: `seg-${i}-v`,
          world: midV,
          meters: seg.metrics.heightM,
          variant: "break",
          segmentIndex: i,
        });
        specs.push({
          id: `seg-${i}-h`,
          world: midH,
          meters: seg.metrics.horizontalM,
          variant: "break",
          segmentIndex: i,
        });
      }
    });

    this.overlay.syncDimensionBadges(canvas, camera, specs, onPick);

    if (this.active) {
      this.overlay.setSnapMarker(canvas, camera, this.hoverWorld);
    } else {
      this.overlay.hideSnap();
    }
  }

  async tapCommit(ndc: THREE.Vector2) {
    const ndcCopy = ndc.clone();
    this.tapCommitChain = this.tapCommitChain
      .then(() => this.tapCommitInner(ndcCopy))
      .catch((err) => {
        console.error("[smart-measure] tapCommit failed:", err);
      });
    await this.tapCommitChain;
  }

  private async tapCommitInner(ndc: THREE.Vector2) {
    const world = this.attachedWorld;
    const visuals = this.visuals;
    if (!this.active || !world || !visuals) return;

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const rendererLike = world.renderer as { needsUpdate?: boolean; update?: () => void };
    if (rendererLike && typeof rendererLike.needsUpdate === "boolean") {
      rendererLike.needsUpdate = true;
      rendererLike.update?.();
    }

    const p = await this.measurePickWorldAsync(ndc);
    if (!p) {
      useSmartMeasureStore.getState().setHint("לא נמצאה נקודת הצמדה — נסה קרוב לקודקוד או לקצה");
      return;
    }

    const scene = world.scene.three;
    const up = scene.up.clone();

    if (!this.draftP1) {
      this.draftP1 = p.clone();
      useSmartMeasureStore.getState().setPhase("pickSecond");
      useSmartMeasureStore.getState().setHint("לחץ על נקודה שנייה");
      visuals.clearDraft();
      void world.renderer?.update?.();
      return;
    }

    const p2 = p.clone();
    const p1 = this.draftP1.clone();
    this.draftP1 = null;
    visuals.clearDraft();

    const metrics = computeSmartMeasureMetrics(p1, p2, up);
    const segment: CompletedSmartSegment = { p1, p2, metrics };
    this.segments.push(segment);

    useSmartMeasureStore.getState().appendSegmentMetrics(
      metrics.directM * 1000,
      metrics.heightM * 1000,
      metrics.horizontalM * 1000,
    );

    const store = useSmartMeasureStore.getState();
    const breakdownIdx = store.detailsSegmentIndex;
    const segmentIndex = this.segments.length - 1;
    visuals.addCompleted(segment, breakdownIdx, segmentIndex);

    if (this.segments.length === 1) {
      useSmartMeasureStore.getState().setHint("לחץ על תווית המרחק להצגת גובה ומרחק אופקי; לחיצה נוספת סוגרת.");
    }

    void world.renderer?.update?.();
  }

  clearAll() {
    this.draftP1 = null;
    this.hoverWorld = null;
    this.segments = [];
    this.visuals?.clearDraft();
    this.visuals?.clearCompleted();
    this.overlay?.clearDom();
    useSmartMeasureStore.getState().resetSession();
    void this.attachedWorld?.renderer?.update?.();
  }

  shutdown() {
    this.cancelHoverRaf();
    this.unsubBreakdown?.();
    this.unsubBreakdown = null;
    this.active = false;
    const scene = this.attachedWorld?.scene.three;
    if (scene && this.visuals) {
      scene.remove(this.visuals.root);
      this.visuals.dispose();
      this.visuals = null;
    }
    this.overlay?.dispose();
    this.overlay = null;
    this.attachedWorld = null;
    const lib = this.safeLibraryMeasurer();
    silenceLengthMeasurement(lib);
    try {
      if (lib) lib.world = null;
    } catch {
      /* noop */
    }
  }
}
