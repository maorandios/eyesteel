import * as THREE from "three";
import type { SmartMeasureMetrics } from "@/lib/viewer/measurement/smart-measure-math";

const MAIN_COLOR = 0x404040;
const DRAFT_COLOR = 0x7a8a9e;
const BREAKDOWN_COLOR = 0x5c6b7c;

function lineGeom(a: THREE.Vector3, b: THREE.Vector3): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setFromPoints([a.clone(), b.clone()]);
  return g;
}

export type CompletedSmartSegment = {
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  metrics: SmartMeasureMetrics;
};

/** WebGL lines for main segment + optional vertical / horizontal breakdown. */
export class SmartMeasureVisuals {
  readonly root = new THREE.Group();
  private readonly completed = new THREE.Group();
  private draftLine: THREE.Line | null = null;

  private readonly matMain = new THREE.LineBasicMaterial({ color: MAIN_COLOR, depthTest: true });
  private readonly matDraft = new THREE.LineBasicMaterial({
    color: DRAFT_COLOR,
    depthTest: true,
    transparent: true,
    opacity: 0.75,
  });
  private readonly matBreak = new THREE.LineBasicMaterial({
    color: BREAKDOWN_COLOR,
    depthTest: true,
    transparent: true,
    opacity: 0.9,
  });

  constructor() {
    this.root.name = "eyeSteelSmartMeasure";
    this.completed.name = "eyeSteelSmartMeasureCompleted";
    this.root.add(this.completed);
  }

  dispose() {
    this.clearDraft();
    this.clearCompleted();
    this.matMain.dispose();
    this.matDraft.dispose();
    this.matBreak.dispose();
  }

  private disposeLineBranch(obj: THREE.Object3D) {
    obj.traverse((o) => {
      const line = o as THREE.Line;
      if (line.isLine && line.geometry) line.geometry.dispose();
    });
  }

  clearCompleted() {
    for (const child of [...this.completed.children]) {
      this.disposeLineBranch(child);
      this.completed.remove(child);
    }
  }

  clearDraft() {
    if (this.draftLine) {
      this.draftLine.geometry.dispose();
      this.root.remove(this.draftLine);
      this.draftLine = null;
    }
  }

  setDraft(p1: THREE.Vector3 | null, p2: THREE.Vector3 | null) {
    this.clearDraft();
    if (!p1 || !p2) return;
    const g = lineGeom(p1, p2);
    this.draftLine = new THREE.Line(g, this.matDraft);
    this.root.add(this.draftLine);
  }

  addCompleted(
    segment: CompletedSmartSegment,
    breakdownSegmentIndex: number | null,
    segmentIndex: number,
  ) {
    const { p1, p2, metrics } = segment;
    const gMain = lineGeom(p1, p2);
    const main = new THREE.Line(gMain, this.matMain);
    this.completed.add(main);

    if (breakdownSegmentIndex !== segmentIndex) return;

    const extra = new THREE.Group();
    extra.add(new THREE.Line(lineGeom(p1, metrics.corner), this.matBreak));
    extra.add(new THREE.Line(lineGeom(metrics.corner, p2), this.matBreak));
    this.completed.add(extra);
  }

  rebuildCompleted(segments: CompletedSmartSegment[], breakdownSegmentIndex: number | null) {
    this.clearCompleted();
    segments.forEach((s, i) => this.addCompleted(s, breakdownSegmentIndex, i));
  }
}
