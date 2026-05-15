"use client";

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import CameraControls from "camera-controls";
import { LodMode, type FragmentsModel, type MeshData } from "@thatopen/fragments";
import type { AnalyzerBoltRow, AnalyzerOutput, ViewerMode } from "@/types/domain";
import { loadIfcModel } from "@/lib/viewer/ifc-loader";
import { expandIfcGuidLookupVariants, normalizeIfcGuidKey } from "@/lib/viewer/ifc-guid";
import { MeasurementController } from "@/lib/viewer/measurement/measurement-controller";
import {
  CONTEXT_GHOST_FACE_OPACITY,
  CONTEXT_GHOST_SNAPSHOT_NAME,
  EYE_STEEL_SCENE_BACKGROUND_HEX,
  SELECTION_HIGHLIGHT_COLOR,
  applyEyeSteelRendererDefaults,
  applyEyeSteelSceneBackdrop,
  buildSelectionHighlightMaterial,
  createEyeSteelLights,
} from "@/lib/viewer/visual-policy";
import {
  attachSketchEdges,
  createSketchFillMaterial,
  createTechnicalSketchLineBasicMaterial,
  ensureSketchEdgesAttached,
  isLodFragmentMaterial,
  restoreSketchLineSegmentsUnifiedMaterialSwap,
  restoreSelectionTintOnSketchLineSegments,
  setContextIsolationEdgeOpacity,
  setTechnicalSketchUnifiedStroke,
  setSketchEdgeVisibility,
  stripSketchEdgeChildren,
  swapSketchLineSegmentsToUnifiedMaterial,
} from "@/lib/viewer/sketch-mode";
import {
  VIEW_FILTER_EDGE_OVERLAY_NAME,
  buildPickedEdgeOverlay,
  disposeConstructedEdgeOverlayGroup,
  disposePickedEdgeOverlay,
} from "@/lib/viewer/picked-edge-overlay";
import {
  cameraUpForViewMode,
  eyePositionFromCenter,
  type ViewModeId,
} from "@/lib/viewer/view-mode-presets";
import {
  boundingBoxHalfExtentsInOrthoCameraPlane,
  fitOrthoSymmetricFrustum,
  orthoContentHalfExtentsForViewMode,
  pickInspectionViewModeFromBox,
} from "@/lib/viewer/inspection-view";
import {
  CLIPPING_LABELS_HE,
  type ClippingDirectionId,
  type ViewerClippingUiSnapshot,
  normalForClippingDirection,
} from "@/lib/viewer/clipping-presets";
import type { IsolationMode } from "@/lib/state/isolation-store";

/** Orbit view axis used by camera-controls’ orthographic zoom-to-cursor math (not part of public typings). */
type CameraControlsOrbital = CameraControls & {
  _getCameraDirection(out: THREE.Vector3): THREE.Vector3;
};

export interface PickHit {
  localId: number;
  itemId: number;
  /** Viewport CSS pixels of the tap — for contextual UI anchored to the pick. */
  clientX?: number;
  clientY?: number;
  /** Mouse button used for this pick. 0 = left click, 2 = right click. */
  button?: number;
  /** Desktop shortcut modifier captured at pointer-up time. */
  ctrlKey?: boolean;
}

/** Saved before מצב בדיקה so camera + orthographic מבט restore exactly after exit. */
export type ViewerCameraRevertSnapshot = {
  orthoMode: ViewModeId | null;
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  /** {@link THREE.OrthographicCamera.zoom} when {@link orthoMode} is set; unused for perspective. */
  orthoZoom: number;
};

export type ApplyIsolationOptions = {
  focus?: boolean;
  /**
   * Analyzer bolt GlobalIds (normalized keys) for pre-seeding IFC-linked bolts.
   * With `useIfcBoltSteelRelationIsolation`, `ConnectedTo` graph merge does **not** apply a strict
   * fragment-GUID allowlist (analyzer vs fragment GUID mismatch would hide every fastener).
   * Legacy isolation still passes this into graph merge as a GUID gate when the flag is off.
   */
  boltGuidIsolationAllowlist?: ReadonlySet<string>;
  /**
   * When set, bbox fastener merge additionally filters by GUID. **Omit** to keep every fastener
   * category hit inside the padded isolation probe (paired with graph merge).
   */
  spatialBoltIsolationAllowlist?: ReadonlySet<string>;
  /**
   * `boltSteelLinks` from the analyzer: skip bbox fastener sweep + centroid prune; seed linked bolts
   * via {@link relationBoltGlobalIdsRaw} / allowlist before `ConnectedTo` merges.
   */
  useIfcBoltSteelRelationIsolation?: boolean;
  /**
   * Exporter-spelled bolt GlobalIds from matching link rows (for `getLocalIdsByGuids`).
   */
  relationBoltGlobalIdsRaw?: readonly string[];
  /**
   * מצב בדיקה: readable LOD faces (instead of opacity 0) + edge overlay ids = full merged `selected`
   * so base plates / merged hardware still draw when per-seed `getItemsGeometry` is empty.
   */
  inspectionReadableSketch?: boolean;
  /**
   * מצב ייצור: after the standard isolation merges run, remove every fragment local that
   * {@link ViewerEngine.resolveMechanicalFastenerLocalsToHide} classifies as a fastener (bolts /
   * nuts / washers / Tekla discrete-accessory hardware), while keeping opening / surface-feature
   * holes inside the isolated subset. The result: the steel part(s) keep their cut hole geometry
   * visible, but the standalone bolt-nut-washer shapes that normally pile on top of the hole are
   * hidden — the user sees "where the holes are" without the hardware silhouette covering them.
   *
   * Uses the same fastener classifier as the global "הסתר ברגים, השאר חורים" toolbar toggle so
   * holes (`IfcOpeningElement`, `IfcSurfaceFeature` bore meshes, etc.) stay visible.
   */
  hideBoltsKeepHoles?: boolean;
  /**
   * מצב ייצור: after merges, remove fastener / washer locals whose GUID is not in
   * {@link boltGuidIsolationAllowlist} (same set as red hole discs). Keeps openings and structural
   * `IfcDiscreteAccessory` plates; requires non-empty allowlist.
   */
  enforceProductionBoltHardwareAllowlist?: boolean;
  /**
   * מצב ייצור: normalized IFC GlobalId keys for steel in the current subset (column, plates, …).
   * With {@link enforceProductionBoltHardwareAllowlist}, merged non‑seed fragments whose GUID is
   * neither here nor in the bolt allowlist are removed (catches mis‑typed bolt tiles and neighbour
   * steel that still sits inside a tall column’s axis‑aligned hull).
   */
  productionVisibleSteelGuidKeys?: ReadonlySet<string>;
};

/**
 * Synthetic bolt‑hole cylinders for מצב ייצור when IFC exports omit `IfcOpeningElement` voids
 * but still expose fastener solids + hole diameters on bolt property sets.
 */
export type ProductionHoleOverlayInput = {
  boltSteelLinks: readonly { boltGlobalId: string; partGlobalId: string }[];
  bolts: readonly Pick<AnalyzerBoltRow, "id" | "expressId" | "boltHoleDiameterMm">[];
  /** IFC GlobalIds of visible steel in this ייצור view (link matching + overlay gating). */
  visibleSteelPartIds: readonly string[];
  /**
   * Same steel as {@link visibleSteelPartIds} with analyzer `expressId` — improves worker mapping when
   * GUID spellings diverge; omit if unknown.
   */
  visibleSteelRefs?: readonly { id: string; expressId: number | null }[];
  /**
   * Extra bolts to draw (merged from {@link analyzerBoltsForProductionHoleOverlay}) when
   * `boltSteelLinks` uses GUIDs that do not match assembly `parts` / Tekla omits relations.
   */
  overlayBoltRows?: readonly Pick<AnalyzerBoltRow, "id" | "expressId" | "boltHoleDiameterMm">[];
  /**
   * When set (after {@link ViewerEngine.applyIsolation}), only draw hole discs for fasteners whose
   * `localId` is still worker-visible — removes “ghost” discs for bolts pruned from isolation.
   */
  fastenerDiscLocalIdAllowlist?: ReadonlySet<number>;
  /** @deprecated No longer used — hole locals come only from analyzer bolt GUIDs (links + overlay rows). */
  candidateLocalIds?: readonly number[];
  /**
   * Fragment locals for the isolated steel seed (same set passed to {@link applyIsolation}). Unions
   * their hull into {@link buildProductionBoltAllowlistPayload} so red discs use the real column
   * geometry even when analyzer→fragment steel GUID mapping misses the member.
   */
  isolationSteelLocalIds?: readonly number[];
};

export type ViewerToolMode = "none" | "measurement" | "flash";

/** Tap classification — fingers jitter more than mouse cursors. */
const TAP_SLOP_SQ_MOUSE = 144;
const TAP_SLOP_SQ_TOUCH = 900;
const TAP_MAX_MS_MOUSE = 700;
const TAP_MAX_MS_TOUCH = 950;

const ORTHO_MARGIN = 1.08;
/** Tighter framing in מצב בדיקה so the part fills the orthographic view. */
/** Extra air around AABB in ortho (inspection only), after accurate camera-space fit. */
const INSPECTION_ORTHO_MARGIN = 1.12;
/** Sketch + isolated would otherwise use lodOpacity 0 with edges-only — thin plates can vanish if edge geometry is empty. */
const INSPECTION_SKETCH_LOD_FACE_OPACITY = 0.34;
const ORTHO_DISTANCE_K = 1.75;
const SELECTION_EDGE_FACE_COLOR = SELECTION_HIGHLIGHT_COLOR.clone().lerp(new THREE.Color(0xffffff), 0.1);
/** Top toolbar / mode strip (px) — ortho מבט centers in the band below this and above the dock. */
const VIEWER_TOP_CHROME_PX = 80;
/** Bottom floating dock + gap (px). */
const VIEWER_BOTTOM_DOCK_RESERVE_PX = 176;
const FRAGMENTS_LOD_GEOMETRY = 0 as const;
/**
 * Extra zoom‑out on top of {@link ORTHO_MARGIN} for docked מבט / section ortho so the full face has
 * clear margin inside the visible viewport (not edge‑clipped).
 */
const ORTHO_VIEW_DOCK_EXTRA_MARGIN = 1.14;

/** Worker batch size for `setVisible` / `setOpacity` on large Tekla models (mobile-safe). */
const ISOLATION_WORKER_CHUNK = 384;

/**
 * Above this steel AABB diagonal (IFC metres), centroid→hull slack cannot distinguish joints along one
 * long `IfcBeam`/`IfcMember` instance — relation isolation keeps link-allowlisted bolts and drops the rest,
 * optionally keeping tiny washers that still hug the surface (see prune).
 */
const LONG_SINGLE_STEEL_DIAGONAL_M = 2.0;

/**
 * Loose category match for spatial queries — supplements IFC graph when exporters omit connects.
 */
const FASTENER_ITEMS_BY_QUERY_REGEX: RegExp[] = [/MECHANICALFASTENER/i, /\bIFCFASTENER\b/i, /DISCRETEACCESSORY/i];

/** One decoded fragment sample (model-object space) before collinearity clustering. */
type ProductionSampleCandidate = { pos: THREE.Vector3; axis: THREE.Vector3 };

/** Max perpendicular distance (m) between sample origins for “same bolt” merge (head/shank/nut solids). */
const BOLT_SAMPLE_CLUSTER_PERP_TOL_M = 0.028;

function clusterFastenerSamplesByCollinearity(
  candidates: ProductionSampleCandidate[],
  perpTol: number,
): ProductionSampleCandidate[][] {
  const n = candidates.length;
  if (n === 0) return [];
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== i) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < n; i++) {
    const ai = candidates[i].axis;
    const pi = candidates[i].pos;
    for (let j = i + 1; j < n; j++) {
      const aj = candidates[j].axis;
      if (Math.abs(ai.dot(aj)) < 0.96) continue;
      const dx = candidates[j].pos.x - pi.x;
      const dy = candidates[j].pos.y - pi.y;
      const dz = candidates[j].pos.z - pi.z;
      const along = dx * ai.x + dy * ai.y + dz * ai.z;
      const px = dx - along * ai.x;
      const py = dy - along * ai.y;
      const pz = dz - along * ai.z;
      if (px * px + py * py + pz * pz < perpTol * perpTol) {
        union(i, j);
      }
    }
  }
  const byRoot = new Map<number, ProductionSampleCandidate[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let arr = byRoot.get(r);
    if (!arr) {
      arr = [];
      byRoot.set(r, arr);
    }
    arr.push(candidates[i]);
  }
  return [...byRoot.values()];
}

/**
 * Distance from a world-space point to the **surface** of an axis-aligned box.
 * (Unlike {@link THREE.Box3#clampPoint} distance, interior points get the depth to the nearest face,
 * not zero — I-beam voids no longer make every nut sample “distance 0” from the hull.)
 */
function distancePointWorldToAabbSurface(box: THREE.Box3, pointWorld: THREE.Vector3): number {
  const clamped = new THREE.Vector3();
  box.clampPoint(pointWorld, clamped);
  const d = pointWorld.distanceTo(clamped);
  if (d > 1e-9) return d;
  const { min, max } = box;
  return Math.min(
    pointWorld.x - min.x,
    max.x - pointWorld.x,
    pointWorld.y - min.y,
    max.y - pointWorld.y,
    pointWorld.z - min.z,
    max.z - pointWorld.z,
  );
}

/**
 * Distance from a world-space point to the **closest** surface across a list of per-member AABBs,
 * with a fallback to a single union AABB. Per-member boxes are critical for column assemblies
 * where a wider base plate inflates the union → column-flange bolts otherwise sit "deep inside"
 * the union and are wrongly rejected.
 */
function distancePointWorldToClosestPartSurface(
  perPartBoxes: readonly THREE.Box3[] | null,
  unionBox: THREE.Box3 | null,
  pointWorld: THREE.Vector3,
): number {
  if (perPartBoxes && perPartBoxes.length > 0) {
    let best = Infinity;
    for (const box of perPartBoxes) {
      if (!box || box.isEmpty()) continue;
      const d = distancePointWorldToAabbSurface(box, pointWorld);
      if (d < best) best = d;
    }
    if (Number.isFinite(best)) return best;
  }
  if (unionBox && !unionBox.isEmpty()) {
    return distancePointWorldToAabbSurface(unionBox, pointWorld);
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Pick one hole reference per physical fastener cluster: sample with minimum distance to the steel
 * **skin** (closest member AABB surface), so top-flange heads win over cavity nuts; interior void
 * tie-breaking is gone.
 */
function pickHoleLikeSampleForCluster(
  cluster: ProductionSampleCandidate[],
  steelPerPartBoxesWorld: readonly THREE.Box3[] | null,
  steelUnionWorld: THREE.Box3 | null,
  modelObject: THREE.Object3D,
  tmpWorld: THREE.Vector3,
): ProductionSampleCandidate {
  if (cluster.length === 1) return cluster[0];
  const hasAnySteel =
    (steelPerPartBoxesWorld && steelPerPartBoxesWorld.length > 0) ||
    (steelUnionWorld && !steelUnionWorld.isEmpty());
  if (hasAnySteel) {
    let best = cluster[0];
    let bestD = Infinity;
    for (const c of cluster) {
      tmpWorld.copy(c.pos).applyMatrix4(modelObject.matrixWorld);
      const d = distancePointWorldToClosestPartSurface(
        steelPerPartBoxesWorld ?? null,
        steelUnionWorld,
        tmpWorld,
      );
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
  const axis = cluster[0].axis;
  const bx = cluster[0].pos.x;
  const by = cluster[0].pos.y;
  const bz = cluster[0].pos.z;
  let tMin = Infinity;
  let tMax = -Infinity;
  const tArr: number[] = new Array(cluster.length);
  for (let k = 0; k < cluster.length; k++) {
    const p = cluster[k].pos;
    const t = (p.x - bx) * axis.x + (p.y - by) * axis.y + (p.z - bz) * axis.z;
    tArr[k] = t;
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
  }
  const target = (tMin + tMax) / 2;
  let best = cluster[0];
  let bestErr = Infinity;
  for (let k = 0; k < cluster.length; k++) {
    const err = Math.abs(tArr[k] - target);
    if (err < bestErr) {
      bestErr = err;
      best = cluster[k];
    }
  }
  return best;
}

export class ViewerEngine {
  private readonly container: HTMLDivElement;
  private readonly components: OBC.Components;
  private world!: OBC.World;
  private modelObject: THREE.Object3D | null = null;
  private modelId: string | null = null;
  /** Normalized IFC GlobalId → ThatOpen fragment local id (see {@link ViewerEngine.syncAnalyzerGuidIndex}). */
  private analyzerGuidKeyToFragmentLocal: Map<string, number> = new Map();
  private disposed = false;
  private readonly viewerLights: THREE.Light[] = [];

  private pointerDownHandler: ((event: PointerEvent) => void) | null = null;
  private pointerMoveHandler: ((event: PointerEvent) => void) | null = null;
  private pointerUpHandler: ((event: PointerEvent) => void) | null = null;
  private pointerCancelHandler: ((event: PointerEvent) => void) | null = null;
  /** Viewer container capture — measurement taps hit here before canvas/CSS layers (mobile-safe). */
  private hostMeasurePointerDownCapture: ((event: PointerEvent) => void) | null = null;
  private readonly lastPointerNdc = new THREE.Vector2(0, 0);
  private downPos: {
    x: number;
    y: number;
    t: number;
    pointerType: string;
    button: number;
    ctrlKey: boolean;
  } | null = null;
  private pickCallback: ((hit: PickHit | null) => void) | null = null;
  private pickPriorityLocalIds: number[] = [];
  private pickPriorityMode: "all" | "right-click" = "all";
  private readonly pickPriorityRaycaster = new THREE.Raycaster();
  /**
   * World point the camera orbits/trucks/dollies around — single source of truth for (1) element tap
   * picks and (2) canvas gestures.
   *
   * Sticky by design: once seeded (by a tap on steel or by the first canvas gesture's sync raycast),
   * it persists across deselects and empty-canvas taps so every subsequent orbit/pan/dolly feels
   * identical to the "picked element" case. Cleared only on programmatic camera teleports
   * (resetView, applyViewMode, restoreCameraRevertSnapshot, focusBboxMap, etc.) — see
   * {@link clearStoredPickOrbitPivot}.
   */
  private pickOrbitPivotActive = false;
  private readonly pickOrbitPivotWorld = new THREE.Vector3();
  /**
   * ~0.75× loaded model world diagonal — scales truck/dolly vs orbit radius so pan/zoom stay usable
   * when zoomed far out on large IFCs (see {@link syncPerspectiveOrbitLimitsClipAndSensitivity}).
   */
  private cameraSensitivityRefDistance = 25;
  private fragmentCameraHooksInstalled = false;
  /** `FragmentsManager.list` is only valid after {@link OBC.FragmentsManager.init}. */
  private fragmentsClippingListenersInstalled = false;
  private readonly measurementController: MeasurementController;
  private viewerTool: ViewerToolMode = "none";
  /** Restore after measurement — only used when we disable orbit on touch (see measurementSuppressedControls). */
  private measurementControlsEnabledSnapshot = true;
  /** True only when measurement mode disabled orbit for a coarse-pointer UI; desktop keeps orbiting. */
  private measurementSuppressedControls = false;
  /** Pose before מצב מדידה — restored on exit so pan/orbit drift does not carry over. */
  private measurementSessionCameraRevert: ViewerCameraRevertSnapshot | null = null;
  /** Browsers often emit synthetic `pointerType: mouse` after touch; ignore briefly so measurement doesn't double-fire. */
  private suppressPrimaryMouseDownUntilMs = 0;

  private perspectiveCamera!: THREE.PerspectiveCamera;
  private readonly orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1e6);
  private boundUseCamera:
    | ((cam: THREE.PerspectiveCamera | THREE.OrthographicCamera) => void)
    | null = null;
  /** Non-null while an orthographic preset is active (resize refit + dispose cleanup). */
  private activeOrthoViewMode: ViewModeId | null = null;
  private orthoResizeHandler: (() => void) | null = null;
  /** White backdrop + dimmed fill lights during מצב בדיקה (restored on exit / dispose). */
  private inspectionPresentationActive = false;
  /** True only during `applyIsolation` with `inspectionReadableSketch` — avoids pre-isolate full-model face lift. */
  private inspectionIsolationSketchReadable = false;
  /** World-space bounds used to refit orthographic presets while inspecting (steel-only framing). */
  private inspectionSessionFramingBox: THREE.Box3 | null = null;
  private readonly inspectionSceneBackground = new THREE.Color(0xf7f8fa);
  private viewerLightIntensityBackup: number[] | null = null;
  /** ייצור: dark cylinder meshes indicating hole axes/diameters when fastener solids are hidden. */
  private productionHoleOverlayGroup: THREE.Group | null = null;
  /**
   * Last ייצור overlay bolt GUID set (normalized keys), including IFC `ConnectedTo` supplements.
   * Drives `applyIsolation` allowlists so the same fasteners get hole discs **and** visibility.
   */
  private productionBoltGuidAllowlistSnapshot: ReadonlySet<string> | null = null;
  private readonly tmpVecEye = new THREE.Vector3();
  private readonly tmpClipNormal = new THREE.Vector3();
  /** Cursor-based orbit pivot for pan/dolly/wheel (see {@link installPerspectiveOrbitPivotFromCursor}). */
  private readonly orbitPivotRaycaster = new THREE.Raycaster();
  private readonly orbitPivotScratchCenter = new THREE.Vector3();
  private orbitPivotControlStartHandler: (() => void) | null = null;
  /**
   * Wheel events in `camera-controls` only dispatch a `control` event (not `controlstart`),
   * so the pivot must be re-seeded from a direct wheel listener — otherwise the stored pivot
   * stays stale after a dolly and the next rotation snaps the orbit back around the old point.
   */
  private wheelDollyPivotReseedHandler: ((event: WheelEvent) => void) | null = null;
  private readonly wheelDollyPivotNdc = new THREE.Vector2();
  /**
   * מבט orthographic: camera-controls’ built-in ortho `dollyToCursor` path is tied to smoothed `_zoom`
   * and often never applies a visible target shift. We handle wheel on the host in capture phase
   * (before the canvas listener) using the same unproject/lerp/pullback as the library, then block the
   * default zoom so the view follows the pointer.
   */
  private orthoViewWheelCaptureHandler: ((e: WheelEvent) => void) | null = null;
  private readonly orthoWheelWorldCursor = new THREE.Vector3();
  private readonly orthoWheelAx = new THREE.Vector3();
  private readonly orthoWheelCursorProj = new THREE.Vector3();
  private readonly orthoWheelNewTarget = new THREE.Vector3();
  private readonly orthoWheelCamDir = new THREE.Vector3();
  private readonly orthoWheelTargetSnap = new THREE.Vector3();

  /** Single user clipping plane (That Open `renderer.setPlane` + fragments bridge). */
  private readonly userClipPlane = new THREE.Plane();
  private userClippingActive = false;
  private userClipDirection: ClippingDirectionId | null = null;
  private userClipFlipped = false;
  private userClipDepthOffset = 0;
  private readonly userClipCenter = new THREE.Vector3();
  private userClipDiagonal = 1;
  private sketchModeEnabled = false;
  private sketchEdgesBuilt = false;
  private sketchFillMaterial: THREE.MeshBasicMaterial | null = null;
  /** Key = edge line color hex (darkened IFC face); reused so palette-sized models don’t allocate one material per mesh. */
  private readonly sketchEdgeMaterialPool = new Map<number, THREE.LineBasicMaterial>();
  /** When שרטוט mode is on, plain-mesh sketch edges share this instead of IFC-tint strokes. */
  private unifiedSketchStrokeMaterial: THREE.LineBasicMaterial | null = null;
  private readonly sketchMaterialBackup = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  /** Fragments {@link LodMaterial} instances — restore `lodOpacity` when exiting sketch. */
  private readonly sketchLodOpacityBackup = new Map<THREE.Material, number>();
  private readonly sceneBackdropDefault = new THREE.Color(EYE_STEEL_SCENE_BACKGROUND_HEX);
  /** Unsubscribes fragment `onViewUpdated` + `tiles.onItemSet` sketch edge sync. */
  private sketchTilesUnsub: (() => void) | null = null;

  /**
   * Fragment isolation visual mode — when not `none`, {@link ViewerEngine.setTransparency} no-ops
   * so mesh traversal does not fight ThatOpen LOD opacity overrides.
   */
  private isolationVisualMode: IsolationMode = "none";
  private readonly contextOverlayMeshes: THREE.Mesh[] = [];
  /**
   * הצג בהקשר: full-opacity edge overlay for the picked items, drawn on top of the dimmed
   * main-view sketch edges. Built per isolation transition by {@link buildPickedEdgeOverlay}
   * (per-item geometry from `getItemsGeometry`, so picking one item never lights up its
   * tile-mates' edges). Cleared by {@link clearContextMainThreadVisuals}.
   */
  private pickedEdgeOverlay: THREE.Group | null = null;
  /**
   * הסתר: fragment local ids suppressed by worker visibility. Used to rebuild per-item remainder edge
   * overlays (LOD tile wires cannot reliably hide subset instances inside a tile at 100% opacity).
   */
  private isolationHiddenExcludedLocals: Set<number> | null = null;
  /** After **בודד** `applyIsolation`, every fragment local still visible (steel + allowed fasteners). */
  private lastIsolatedVisibleLocals: Set<number> | null = null;
  private hiddenRemainderSketchNonce = 0;
  private hiddenRemainderSketchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * סינון תצוגה sketch outlines — native per-tile rails off; remainder from {@link buildPickedEdgeOverlay}
   * (same leak fix as isolation הסתר for batched LOD wires).
   */
  private viewFilterEdgeOverlay: THREE.Group | null = null;
  private viewFilterSuppressMainSketchEdges = false;
  /**
   * Serializes isolation RPCs + tile sync. Overlapping `applyIsolation` / `clearIsolationVisuals` (e.g. UI +
   * selection effects) yields a visible "blink" then a stale view on the ThatOpen worker/main bridge.
   */
  private isolationChain: Promise<void> = Promise.resolve();

  private clearStoredPickOrbitPivot(): void {
    this.pickOrbitPivotActive = false;
  }

  private refreshCameraSensitivityRefFromModel(): void {
    if (!this.modelObject) {
      this.cameraSensitivityRefDistance = 25;
      return;
    }
    const box = new THREE.Box3().setFromObject(this.modelObject);
    if (box.isEmpty()) {
      this.cameraSensitivityRefDistance = 25;
      return;
    }
    const span = box.getSize(new THREE.Vector3()).length();
    this.cameraSensitivityRefDistance = Math.max(8, span * 0.75);
  }

  /**
   * Each frame: clamp orbit radius (prevents float blow-up + unusable pan/zoom), keep far/near
   * in a depth-friendly ratio, and scale truck/dolly. Without a max orbit distance, zoom-out can
   * push `distance` so high that depth buffer + picks break and איפוס מבט cannot recover cleanly.
   */
  private syncPerspectiveOrbitLimitsClipAndSensitivity(): void {
    if (this.disposed || !this.modelObject || this.activeOrthoViewMode !== null) return;
    const cam = this.world.camera.three;
    if (!cam || !(cam as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    const persp = cam as THREE.PerspectiveCamera;
    const ctrl = this.world.camera.controls as CameraControls | null | undefined;
    if (!ctrl) return;

    const box = new THREE.Box3().setFromObject(this.modelObject);
    if (box.isEmpty()) return;
    const span = box.getSize(new THREE.Vector3()).length();
    const ref = Math.max(1, this.cameraSensitivityRefDistance);
    /** Hard cap ~tens of km — enough for site-scale IFC without breaking GPU depth precision. */
    const maxD = Math.min(180_000, Math.max(ref * 38, span * 45, 250));

    let d = ctrl.distance;
    if (!Number.isFinite(d) || d <= 0 || d > 1e12) {
      const sph = box.getBoundingSphere(new THREE.Sphere());
      const r = Math.max(sph.radius, span * 0.25, 1);
      this.frameCameraIsoDiagonal(sph.center, r);
      void ctrl.stop?.();
      void ctrl.update?.(0);
      d = ctrl.distance;
    } else if (d > maxD) {
      ctrl.dollyTo(maxD, false);
      void ctrl.stop?.();
      void ctrl.update?.(0);
      d = maxD;
    }

    ctrl.maxDistance = maxD * 1.02;

    const far = Math.min(600_000, Math.max(d * 2.6 + span * 6, span * 14, 25_000));
    const ratioCap = 120_000;
    let near = 0.01;
    if (far / near > ratioCap) near = far / ratioCap;
    near = Math.max(0.01, Math.min(near, Math.max(d * 0.15, 0.01)));

    const prevFar = persp.far;
    const prevNear = persp.near;
    if (
      Math.abs(far - prevFar) / Math.max(prevFar, 1) > 0.008 ||
      Math.abs(near - prevNear) > 1e-6
    ) {
      persp.near = near;
      persp.far = far;
      persp.updateProjectionMatrix();
    }

    /**
     * Gentle log ramps when orbit radius ≫ model ref. Softer bases than stock (2 / 1).
     * When zoomed in (small d vs ref), ease truck + wheel dolly so focus-pull doesn’t jump.
     */
    const ratio = Math.max(1, Math.min(d / ref, 4096));
    const truckGain = Math.min(1.1, 1 + 0.05 * Math.log2(ratio));
    const dollyGain = Math.min(1.08, 1 + 0.03 * Math.log2(ratio));
    const truckBase = 1.12;
    const dollyBase = 0.52;
    const closeT = Math.min(1, d / Math.max(ref * 0.32, 1e-6));
    const truckCloseFactor = 0.42 + 0.58 * Math.pow(closeT, 0.9);
    const dollyCloseFactor = 0.28 + 0.72 * Math.pow(closeT, 1.1);
    const truck = truckBase * truckGain * truckCloseFactor;
    let dolly = dollyBase * dollyGain * dollyCloseFactor;
    if (this.isInspectionVisualizationSessionActive()) {
      dolly *= 0.82;
    }
    ctrl.truckSpeed = truck;
    ctrl.dollySpeed = dolly;
  }

  constructor(container: HTMLDivElement) {
    this.container = container;
    this.components = new OBC.Components();
    this.measurementController = new MeasurementController(this.components);
    this.setupWorld();
  }

  private setupWorld() {
    const worlds = this.components.get(OBC.Worlds);
    this.world = worlds.create<OBC.SimpleScene, OBC.SimpleCamera, OBF.RendererWith2D>();
    this.world.scene = new OBC.SimpleScene(this.components);
    this.world.renderer = new OBF.RendererWith2D(this.components, this.container);
    this.world.camera = new OBC.SimpleCamera(this.components);

    const rw = this.world.renderer as OBF.RendererWith2D;
    rw.showLogo = false;

    this.components.init();
    (this.world.scene as OBC.SimpleScene).setup();
    const sceneRoot = this.world.scene.three as THREE.Scene;
    sceneRoot.up.set(0, 1, 0);
    const camThree = this.world.camera.three as THREE.PerspectiveCamera;
    this.perspectiveCamera = camThree;
    camThree.up.copy(sceneRoot.up);
    this.world.camera.controls?.updateCameraUp();
    this.world.camera.controls?.setLookAt(14, 14, 14, 0, 0, 0, false);
    this.applySnappyCameraControls();
    const ctrl0 = this.world.camera.controls;
    if (ctrl0) this.applyPerspectiveNavigationBindings(ctrl0);
    this.applyPerspectiveClipPlanes();
    this.installFragmentCameraSyncOnce();

    this.measurementController.attach(this.world);

    const scene = this.world.scene.three as THREE.Scene;
    applyEyeSteelSceneBackdrop(scene);
    this.viewerLights.push(...createEyeSteelLights(scene));

    const renderer = this.world.renderer as OBF.RendererWith2D;
    const syncCss2dOverlay = () => {
      const el = renderer.container;
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        renderer.three2D.setSize(el.clientWidth, el.clientHeight);
      }
    };
    applyEyeSteelRendererDefaults(renderer.three);
    syncCss2dOverlay();
    renderer.onResize.add(() => {
      applyEyeSteelRendererDefaults(renderer.three);
      syncCss2dOverlay();
    });

    renderer.onClippingPlanesUpdated.add(() => {
      if (this.disposed) return;
      const fm = this.components.get(OBC.FragmentsManager);
      if (!fm.initialized) return;
      void fm.core.update(true);
    });

    renderer.onBeforeUpdate.add(() => {
      if (!this.disposed) this.measurementController.suppressVertexPickerMarker();
    });

    renderer.onAfterUpdate.add(() => {
      if (!this.disposed) this.measurementController.syncHtmlLabels();
    });

    this.installPointerListeners();
    this.installPerspectiveOrbitPivotFromCursor();
    this.installPerspectiveWheelPivotReseed();
    this.installOrthoViewZoomTowardCursor();
    /* Ensure the host div (not only the canvas) never scrolls the page instead of delivering gestures. */
    this.container.style.touchAction = "none";
  }

  /**
   * {@link OBC.SimpleCamera} defaults to PerspectiveCamera(…, near=1, far=1000), which clips mesh
   * when dollying in close. Pull `near` in and extend `far` so zoom never slices steel.
   */
  private applyPerspectiveClipPlanes(modelRoot?: THREE.Object3D) {
    const cam = this.world.camera.three;
    if (!cam || !(cam as THREE.PerspectiveCamera).isPerspectiveCamera) return;
    const persp = cam as THREE.PerspectiveCamera;
    persp.near = 0.01;
    if (modelRoot) {
      const box = new THREE.Box3().setFromObject(modelRoot);
      const span = box.getSize(new THREE.Vector3()).length();
      /** Baseline; {@link syncPerspectiveOrbitLimitsClipAndSensitivity} refines each frame. */
      persp.far = Math.max(20_000, span * 30, 60_000);
    } else {
      persp.far = 400_000;
    }
    persp.updateProjectionMatrix();
  }

  private fitAllPerspective() {
    if (!this.modelObject) return;
    this.applyPerspectiveClipPlanes(this.modelObject);
    const box = new THREE.Box3().setFromObject(this.modelObject);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.frameCameraIsoDiagonal(sphere.center, sphere.radius);
  }

  private syncFragmentsAfterCameraSwap() {
    const fragments = this.components.get(OBC.FragmentsManager);
    if (fragments.initialized) void fragments.core.update(true);
  }

  /**
   * After orthographic frustum + look-at, nudge the camera so the orbit target aligns with the
   * **visible** viewport midline (canvas minus top toolbar and bottom dock), not the raw canvas center.
   * Uses {@link CameraControls#setFocalOffset} with the same scale as orthographic screen-pan (pedestal).
   */
  private applyBottomDockOrthoFocalCompensation(): void {
    if (this.disposed || this.activeOrthoViewMode === null) return;
    const ctrl = this.world.camera.controls as CameraControls | undefined;
    const ortho = this.world.camera.three;
    if (!ctrl || !(ortho instanceof THREE.OrthographicCamera)) return;
    const renderer = this.world.renderer as OBF.RendererWith2D;
    const el = renderer.container;
    const h = el.clientHeight;
    if (!(h > 0)) return;
    const vSpan = (ortho.top - ortho.bottom) / ortho.zoom;
    /** Canvas midline → midline of [top chrome … h − bottom dock] (see camera-controls ortho `pedestalY`). */
    const shiftPx = (VIEWER_BOTTOM_DOCK_RESERVE_PX - VIEWER_TOP_CHROME_PX) * 0.5;
    const focalY = (shiftPx * vSpan) / h;
    void ctrl.setFocalOffset(0, focalY, 0, false);
    void ctrl.update(0);
  }

  private updateOrthoFrustum(
    box: THREE.Box3,
    dockChromeFitting = false,
    mode?: ViewModeId,
  ) {
    const renderer = this.world.renderer as OBF.RendererWith2D;
    const el = renderer.container;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const topPad = dockChromeFitting ? VIEWER_TOP_CHROME_PX : 0;
    const bottomPad = dockChromeFitting ? VIEWER_BOTTOM_DOCK_RESERVE_PX : 0;
    const hEff = Math.max(h - topPad - bottomPad, 1);
    const aspect = w > 0 && h > 0 ? w / h : 1;
    let marginFactor = this.inspectionSessionFramingBox !== null ? INSPECTION_ORTHO_MARGIN : ORTHO_MARGIN;
    if (dockChromeFitting && this.inspectionSessionFramingBox === null) {
      marginFactor *= ORTHO_VIEW_DOCK_EXTRA_MARGIN;
    }
    if (mode) {
      const size = box.getSize(new THREE.Vector3());
      const extents = orthoContentHalfExtentsForViewMode(mode, size);
      const visibleHeightScale = dockChromeFitting && h > 0 ? h / hEff : 1;
      const { halfWidth, halfHeight } = fitOrthoSymmetricFrustum(
        extents.horizontal,
        extents.vertical * visibleHeightScale,
        aspect,
        marginFactor,
      );
      const ortho = this.orthographicCamera;
      ortho.left = -halfWidth;
      ortho.right = halfWidth;
      ortho.top = halfHeight;
      ortho.bottom = -halfHeight;
      ortho.near = 0.01;
      ortho.far = 1e6;
      ortho.updateProjectionMatrix();
      return;
    }
    this.updateOrthoFrustumForAspect(box, aspect, marginFactor);
  }

  private updateOrthoFrustumForAspect(box: THREE.Box3, aspect: number, marginFactor = ORTHO_MARGIN) {
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const halfBase = 0.5 * maxDim * marginFactor;
    const ortho = this.orthographicCamera;
    const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
    if (safeAspect >= 1) {
      const halfW = halfBase * safeAspect;
      ortho.left = -halfW;
      ortho.right = halfW;
      ortho.top = halfBase;
      ortho.bottom = -halfBase;
    } else {
      const halfH = halfBase / safeAspect;
      ortho.left = -halfBase;
      ortho.right = halfBase;
      ortho.top = halfH;
      ortho.bottom = -halfH;
    }
    ortho.near = 0.01;
    ortho.far = 1e6;
    ortho.updateProjectionMatrix();
  }

  /**
   * CameraControls picks DOLLY vs ZOOM from the **initial** camera type only; assigning `ctrl.camera`
   * does not refresh bindings. Keep orthographic מבט on zoom + pan so wheel adjusts {@link THREE.OrthographicCamera.zoom}
   * instead of dollying (which reads like clipping through cuts).
   */
  private applyPerspectiveNavigationBindings(ctrl: CameraControls) {
    const A = CameraControls.ACTION;
    ctrl.mouseButtons.left = A.ROTATE;
    ctrl.mouseButtons.middle = A.DOLLY;
    ctrl.mouseButtons.right = A.TRUCK;
    ctrl.mouseButtons.wheel = A.DOLLY;
    ctrl.touches.one = A.TOUCH_ROTATE;
    ctrl.touches.two = A.TOUCH_DOLLY_TRUCK;
    ctrl.touches.three = A.TOUCH_TRUCK;
  }

  /** Orthographic preset: no orbit — pan (screen / truck) + orthographic zoom only. */
  private applyOrthographicPlanNavigationBindings(ctrl: CameraControls) {
    const A = CameraControls.ACTION;
    ctrl.mouseButtons.left = A.SCREEN_PAN;
    ctrl.mouseButtons.middle = A.ZOOM;
    ctrl.mouseButtons.right = A.TRUCK;
    ctrl.mouseButtons.wheel = A.ZOOM;
    ctrl.touches.one = A.TOUCH_SCREEN_PAN;
    ctrl.touches.two = A.TOUCH_ZOOM_TRUCK;
    ctrl.touches.three = A.TOUCH_TRUCK;
  }

  /**
   * `camera-controls` keeps one `_zoom` for the active camera. Orthographic zoom must not stay on
   * {@link THREE.PerspectiveCamera.zoom} after מצב בדיקה / ortho מבט — it blows out the projection
   * (extreme wide / fish-eye).
   */
  private resetPerspectiveZoomForControls(ctrl: CameraControls): void {
    this.perspectiveCamera.zoom = 1;
    this.perspectiveCamera.updateProjectionMatrix();
    void ctrl.zoomTo(1, false);
  }

  private attachOrthoResizeListener() {
    this.detachOrthoResizeListener();
    const renderer = this.world.renderer as OBF.RendererWith2D;
    this.orthoResizeHandler = () => {
      if (this.disposed || this.activeOrthoViewMode === null) return;
      const box = new THREE.Box3();
      if (this.inspectionSessionFramingBox) {
        box.copy(this.inspectionSessionFramingBox);
      } else if (this.modelObject) {
        box.setFromObject(this.modelObject);
      }
      if (box.isEmpty()) return;
      if (this.inspectionSessionFramingBox !== null && this.activeOrthoViewMode !== null) {
        this.updateOrthoFrustumForInspectionSnapshot(box);
      } else {
        this.updateOrthoFrustum(box, true, this.activeOrthoViewMode ?? undefined);
      }
      this.applyBottomDockOrthoFocalCompensation();
    };
    renderer.onResize.add(this.orthoResizeHandler);
  }

  /**
   * מצב בדיקה ortho: project framing AABB corners into the **current** camera pose, then grow
   * `left/right/top/bottom` to match canvas aspect. Must run only after `CameraControls`/`lookAt`
   * have updated {@link THREE.OrthographicCamera.matrixWorld}.
   */
  private updateOrthoFrustumForInspectionSnapshot(box: THREE.Box3): void {
    this.world.camera.controls?.update(0);
    const ortho = this.orthographicCamera;
    ortho.updateMatrixWorld(true);

    const renderer = this.world.renderer as OBF.RendererWith2D;
    const el = renderer.container;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const viewportAspect = w > 0 && h > 0 ? w / h : 1;

    const { halfX, halfY } = boundingBoxHalfExtentsInOrthoCameraPlane(ortho, box);
    const { halfWidth, halfHeight } = fitOrthoSymmetricFrustum(
      halfX,
      halfY,
      viewportAspect,
      INSPECTION_ORTHO_MARGIN,
    );

    ortho.left = -halfWidth;
    ortho.right = halfWidth;
    ortho.bottom = -halfHeight;
    ortho.top = halfHeight;
    ortho.near = 0.01;
    ortho.far = 1e6;
    ortho.updateProjectionMatrix();
    this.world.camera.controls?.update(0);
  }

  private detachOrthoResizeListener() {
    if (!this.orthoResizeHandler) return;
    const renderer = this.world.renderer as OBF.RendererWith2D;
    renderer.onResize.remove(this.orthoResizeHandler);
    this.orthoResizeHandler = null;
  }

  /**
   * Orthographic preset along ±world axes (Y‑up scene). Swaps {@link OBC.SimpleCamera.three} and syncs fragments.
   * @returns false when no model or empty bounds.
   */
  applyViewMode(mode: ViewModeId): boolean {
    if (this.disposed || !this.modelObject) return false;
    const box = new THREE.Box3().setFromObject(this.modelObject);
    if (box.isEmpty()) return false;
    this.clearStoredPickOrbitPivot();
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1);
    const distance = ORTHO_DISTANCE_K * span;

    this.updateOrthoFrustum(box, true, mode);

    const simpleCam = this.world.camera as OBC.SimpleCamera;
    const ctrl = simpleCam.controls;
    const ortho = this.orthographicCamera;

    ortho.up.copy(cameraUpForViewMode(mode));

    simpleCam.three = ortho;
    if (ctrl) {
      ctrl.camera = ortho;
      this.applyOrthographicPlanNavigationBindings(ctrl);
      ortho.zoom = 1;
      void ctrl.zoomTo(ortho.zoom, false);
    }

    const eye = eyePositionFromCenter(mode, center, distance, this.tmpVecEye);
    ctrl?.setOrbitPoint(center.x, center.y, center.z);
    ctrl?.updateCameraUp();
    ctrl?.setLookAt(eye.x, eye.y, eye.z, center.x, center.y, center.z, false);
    ctrl?.setFocalOffset(0, 0, 0, false);
    void ctrl?.update(0);

    this.activeOrthoViewMode = mode;
    this.applyBottomDockOrthoFocalCompensation();

    this.boundUseCamera?.(ortho);
    this.syncFragmentsAfterCameraSwap();

    this.attachOrthoResizeListener();
    this.applySnappyCameraControls();
    return true;
  }

  /**
   * Orthographic camera perpendicular to the active clipping plane, orbit point on the plane
   * at the current depth (same as מבט for this axis, but pivot follows the section).
   */
  applySectionViewFromActiveClipping(): boolean {
    if (this.disposed || !this.modelObject || !this.userClippingActive || !this.userClipDirection) return false;

    this.applyUserClippingToRenderer();

    const box = new THREE.Box3().setFromObject(this.modelObject);
    if (box.isEmpty()) return false;
    this.clearStoredPickOrbitPivot();
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1);
    const distance = ORTHO_DISTANCE_K * span;

    const mode = this.userClipDirection;
    this.updateOrthoFrustum(box, true, mode);

    const simpleCam = this.world.camera as OBC.SimpleCamera;
    const ctrl = simpleCam.controls;
    const ortho = this.orthographicCamera;

    ortho.up.copy(cameraUpForViewMode(mode));

    simpleCam.three = ortho;
    if (ctrl) {
      ctrl.camera = ortho;
      this.applyOrthographicPlanNavigationBindings(ctrl);
      ortho.zoom = 1;
      void ctrl.zoomTo(ortho.zoom, false);
    }

    const target = new THREE.Vector3();
    this.userClipPlane.projectPoint(this.userClipCenter, target);

    const eye = this.tmpVecEye.copy(this.userClipPlane.normal).multiplyScalar(-distance).add(target);

    ctrl?.setOrbitPoint(target.x, target.y, target.z);
    ctrl?.updateCameraUp();
    ctrl?.setLookAt(eye.x, eye.y, eye.z, target.x, target.y, target.z, false);
    ctrl?.setFocalOffset(0, 0, 0, false);
    void ctrl?.update(0);

    this.activeOrthoViewMode = mode;
    this.applyBottomDockOrthoFocalCompensation();

    this.boundUseCamera?.(ortho);
    this.syncFragmentsAfterCameraSwap();

    this.attachOrthoResizeListener();
    this.applySnappyCameraControls();
    return true;
  }

  captureCameraRevertSnapshot(): ViewerCameraRevertSnapshot {
    const ctrl = this.world.camera.controls;
    const cam = this.world.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const pos = ctrl?.getPosition(new THREE.Vector3()) ?? cam.position.clone();
    const tgt = ctrl?.getTarget(new THREE.Vector3()) ?? new THREE.Vector3();
    const up = cam.up.clone();
    const orthoZoom = cam instanceof THREE.OrthographicCamera ? cam.zoom : 1;
    return {
      orthoMode: this.activeOrthoViewMode,
      position: pos.toArray() as [number, number, number],
      target: tgt.toArray() as [number, number, number],
      up: up.toArray() as [number, number, number],
      orthoZoom,
    };
  }

  /**
   * @param options.preserveInspectionSession When true, does not clear {@link inspectionSessionFramingBox}
   *   (needed when leaving מדידה while still in מצב בדיקה — full exit still uses default and clears it).
   */
  restoreCameraRevertSnapshot(
    snapshot: ViewerCameraRevertSnapshot,
    options?: { preserveInspectionSession?: boolean },
  ): void {
    if (this.disposed) return;
    const ctrl = this.world.camera.controls;
    const simpleCam = this.world.camera as OBC.SimpleCamera;
    const pos = new THREE.Vector3().fromArray(snapshot.position);
    const tgt = new THREE.Vector3().fromArray(snapshot.target);
    const up = new THREE.Vector3().fromArray(snapshot.up);

    if (!ctrl) return;
    this.clearStoredPickOrbitPivot();
    if (snapshot.orthoMode !== null) {
      this.detachOrthoResizeListener();
      const ortho = this.orthographicCamera;
      ortho.up.copy(up);
      simpleCam.three = ortho;
      ctrl.camera = ortho;
      this.applyOrthographicPlanNavigationBindings(ctrl);
      ortho.zoom = snapshot.orthoZoom;
      void ctrl.zoomTo(ortho.zoom, false);
      ctrl.updateCameraUp();
      ctrl.setLookAt(pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, false);
      this.activeOrthoViewMode = snapshot.orthoMode;
      this.boundUseCamera?.(ortho);
      this.attachOrthoResizeListener();
    } else {
      if (this.activeOrthoViewMode !== null) this.detachOrthoResizeListener();
      this.activeOrthoViewMode = null;
      simpleCam.three = this.perspectiveCamera;
      ctrl.camera = this.perspectiveCamera;
      this.applyPerspectiveNavigationBindings(ctrl);
      this.resetPerspectiveZoomForControls(ctrl);
      this.perspectiveCamera.up.copy(up);
      this.world.scene.three.up.copy(up);
      ctrl.updateCameraUp();
      ctrl.setLookAt(pos.x, pos.y, pos.z, tgt.x, tgt.y, tgt.z, false);
      this.boundUseCamera?.(this.perspectiveCamera);
    }
    this.applySnappyCameraControls();
    /**
     * Do not call `CameraControls#setOrbitPoint` before `setLookAt` here: after swapping
     * ortho ↔ perspective it runs against a stale camera matrix and corrupts target/offset; the
     * saved pose is applied by `setLookAt` alone.
     *
     * Orthographic מצב בדיקה uses pan/truck/zoom — clear residual focal offset after restoring pose.
     */
    ctrl.setFocalOffset(0, 0, 0, false);
    void ctrl.stop?.();
    ctrl.update?.(0);
    if (!options?.preserveInspectionSession && this.inspectionSessionFramingBox !== null) {
      this.clearInspectionVisualizationSession();
    }
    void this.syncFragmentsAfterCameraSwap();
  }

  /**
   * Union of ThatOpen worker bboxes for fragment locals (world space). Used to frame מצב בדיקה
   * on steel-only seeds before bolt merge expands isolation.
   */
  async getMergedWorldBoundingBoxForLocalIds(
    localIds: ReadonlySet<number>,
  ): Promise<THREE.Box3 | null> {
    if (this.disposed || !this.modelId || localIds.size === 0) return null;
    const fragments = this.components.get(OBC.FragmentsManager);
    const map = this.bboxMapFromLocalSet(new Set(localIds));
    try {
      const boxes = await fragments.getBBoxes(map);
      if (!boxes.length) return null;
      const agg = new THREE.Box3();
      boxes.forEach((box) => agg.union(box));
      return agg.isEmpty() ? null : agg;
    } catch {
      return null;
    }
  }

  /** Store AABB refit bounds for orthographic מבט while inspecting (toolbar view cycling). */
  beginInspectionVisualizationSession(framingBox: THREE.Box3): void {
    this.clearStoredPickOrbitPivot();
    this.inspectionSessionFramingBox = framingBox.clone();
  }

  clearInspectionVisualizationSession(): void {
    this.inspectionSessionFramingBox = null;
  }

  isInspectionVisualizationSessionActive(): boolean {
    return this.inspectionSessionFramingBox !== null;
  }

  /** Light backdrop + subdued scene lights so sketch edges read like a tech drawing. */
  setInspectionBackdropAndLights(active: boolean): void {
    if (this.disposed) return;
    if (active === this.inspectionPresentationActive) return;
    const scene = this.world.scene.three as THREE.Scene;
    if (active) {
      if (!this.viewerLightIntensityBackup) {
        this.viewerLightIntensityBackup = this.viewerLights.map((L) => L.intensity);
      }
      scene.background = this.inspectionSceneBackground.clone() as unknown as THREE.Scene["background"];
      for (let i = 0; i < this.viewerLights.length; i++) {
        const L = this.viewerLights[i];
        const base = this.viewerLightIntensityBackup[i] ?? L.intensity;
        L.intensity = base * 0.45;
      }
      this.inspectionPresentationActive = true;
    } else {
      scene.background = this.sceneBackdropDefault.clone() as unknown as THREE.Scene["background"];
      if (this.viewerLightIntensityBackup) {
        for (let i = 0; i < this.viewerLights.length; i++) {
          const L = this.viewerLights[i];
          const base = this.viewerLightIntensityBackup[i];
          if (typeof base === "number") L.intensity = base;
        }
      }
      this.viewerLightIntensityBackup = null;
      this.inspectionPresentationActive = false;
    }
  }

  inspectionSuggestedOrthoMode(box: THREE.Box3): ViewModeId {
    return pickInspectionViewModeFromBox(box);
  }

  /**
   * Orthographic framing for מצב בדיקה using the session steel AABB (tight margin + axis preset).
   * Call after {@link beginInspectionVisualizationSession}.
   */
  applyInspectionOrthographicView(mode: ViewModeId): boolean {
    if (
      this.disposed ||
      !this.modelObject ||
      !this.inspectionSessionFramingBox ||
      this.inspectionSessionFramingBox.isEmpty()
    ) {
      return false;
    }
    this.clearStoredPickOrbitPivot();
    const box = this.inspectionSessionFramingBox;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1);
    const distance = ORTHO_DISTANCE_K * span;

    /** Must be known before resize refit calls {@link attachOrthoResizeListener}. */
    this.activeOrthoViewMode = mode;

    const simpleCam = this.world.camera as OBC.SimpleCamera;
    const ctrl = simpleCam.controls;
    const ortho = this.orthographicCamera;

    ortho.up.copy(cameraUpForViewMode(mode));

    simpleCam.three = ortho;
    if (ctrl) {
      ctrl.camera = ortho;
      this.applyOrthographicPlanNavigationBindings(ctrl);
      ortho.zoom = 1;
      void ctrl.zoomTo(ortho.zoom, false);
      ctrl.stop();
    }

    ctrl?.setOrbitPoint(center.x, center.y, center.z);
    ctrl?.updateCameraUp();
    const eye = eyePositionFromCenter(mode, center, distance, this.tmpVecEye);
    void ctrl?.setLookAt(eye.x, eye.y, eye.z, center.x, center.y, center.z, false);
    ctrl?.setFocalOffset(0, 0, 0, false);
    ctrl?.stop();
    ctrl?.update(0);

    this.updateOrthoFrustumForInspectionSnapshot(box);

    this.applyBottomDockOrthoFocalCompensation();

    this.boundUseCamera?.(ortho);
    void this.syncFragmentsAfterCameraSwap();

    this.attachOrthoResizeListener();
    this.applySnappyCameraControls();
    return true;
  }

  /** Restore perspective camera, fragment projection, and iso frame (same as exiting מבט). */
  exitViewMode(): void {
    if (this.disposed || this.activeOrthoViewMode === null) return;
    this.clearInspectionVisualizationSession();
    this.detachOrthoResizeListener();
    this.activeOrthoViewMode = null;

    const simpleCam = this.world.camera as OBC.SimpleCamera;
    const ctrl = simpleCam.controls;
    simpleCam.three = this.perspectiveCamera;
    if (ctrl) {
      ctrl.camera = this.perspectiveCamera;
      this.applyPerspectiveNavigationBindings(ctrl);
      this.resetPerspectiveZoomForControls(ctrl);
      ctrl.setFocalOffset(0, 0, 0, false);
    }

    this.perspectiveCamera.up.set(0, 1, 0);
    (this.world.scene.three as THREE.Scene).up.set(0, 1, 0);
    ctrl?.updateCameraUp();

    this.boundUseCamera?.(this.perspectiveCamera);
    this.syncFragmentsAfterCameraSwap();

    this.applySnappyCameraControls();
    if (this.modelObject) this.fitAllPerspective();
  }

  /** Library sets smoothTime=0.2 on CameraControls — feels sluggish while orbiting. */
  private applySnappyCameraControls() {
    const c = this.world.camera.controls;
    if (!c) return;
    c.smoothTime = 0;
    c.draggingSmoothTime = 0;
    /**
     * Perspective wheel dolly reads `_dollyControlCoord` when true. Orthographic מבט zoom is applied in
     * {@link installOrthoViewZoomTowardCursor} so the pointer is fixed under the cursor; we still keep
     * this on for middle-button / touch zoom paths inside camera-controls.
     */
    c.dollyToCursor = true;
    c.infinityDolly = false;
    c.minDistance = 0.05;
    /** {@link syncPerspectiveOrbitLimitsClipAndSensitivity} sets a finite cap once the model exists. */
    c.maxDistance = Infinity;
    /** Baselines; {@link syncPerspectiveOrbitLimitsClipAndSensitivity} applies distance + close-in easing. */
    c.truckSpeed = 1.12;
    c.dollySpeed = 0.52;
  }

  /**
   * Pointer-driven orbit/pan/rotate: {@link applyOrbitPivotFromModelPickLikeTap} seeds {@link pickOrbitPivotWorld}.
   * Mouse wheel zoom uses {@link CameraControls#dollyToCursor} only (no per-wheel `setOrbitPoint`).
   */
  private installPerspectiveOrbitPivotFromCursor() {
    const controls = this.world.camera.controls as CameraControls | undefined;
    if (!controls) return;

    this.orbitPivotControlStartHandler = () => {
      if (this.disposed || this.activeOrthoViewMode !== null) return;
      const cam = this.world.camera.three;
      if (!cam || !(cam as THREE.PerspectiveCamera).isPerspectiveCamera) return;

      const A = CameraControls.ACTION;
      const action = controls.currentAction;
      if (action === A.NONE) return;

      const isRotateOnly =
        action === A.ROTATE ||
        action === A.TOUCH_ROTATE ||
        action === A.TOUCH_DOLLY_ROTATE ||
        action === A.TOUCH_ZOOM_ROTATE;
      const movesCamera =
        isRotateOnly ||
        (action & A.TRUCK) === A.TRUCK ||
        (action & A.SCREEN_PAN) === A.SCREEN_PAN ||
        (action & A.DOLLY) === A.DOLLY ||
        (action & A.TOUCH_TRUCK) === A.TOUCH_TRUCK ||
        (action & A.TOUCH_SCREEN_PAN) === A.TOUCH_SCREEN_PAN ||
        (action & A.TOUCH_DOLLY) === A.TOUCH_DOLLY ||
        (action & A.TOUCH_DOLLY_TRUCK) === A.TOUCH_DOLLY_TRUCK ||
        (action & A.TOUCH_DOLLY_SCREEN_PAN) === A.TOUCH_DOLLY_SCREEN_PAN ||
        (action & A.TOUCH_DOLLY_OFFSET) === A.TOUCH_DOLLY_OFFSET ||
        (action & A.TOUCH_DOLLY_ROTATE) === A.TOUCH_DOLLY_ROTATE ||
        (action & A.TOUCH_ZOOM_TRUCK) === A.TOUCH_ZOOM_TRUCK ||
        (action & A.TOUCH_ZOOM_SCREEN_PAN) === A.TOUCH_ZOOM_SCREEN_PAN ||
        (action & A.TOUCH_ZOOM_OFFSET) === A.TOUCH_ZOOM_OFFSET ||
        (action & A.TOUCH_ZOOM_ROTATE) === A.TOUCH_ZOOM_ROTATE;
      if (!movesCamera) return;

      /**
       * The pivot is anchored ONCE per "intent" (pick, canvas tap with a hit, or wheel-zoom over
       * geometry — see {@link installPerspectiveWheelPivotReseed}) and stays locked across many
       * gestures. Re-anchoring per gesture changes the orbit radius each drag and makes the
       * motion feel inconsistent. So when a sticky pivot already exists we reuse it
       * unconditionally; we only seed a fresh one when there is none (first gesture after a
       * programmatic teleport).
       */
      if (this.pickOrbitPivotActive) {
        if (isRotateOnly) {
          void controls.stop?.();
          controls.setOrbitPoint(
            this.pickOrbitPivotWorld.x,
            this.pickOrbitPivotWorld.y,
            this.pickOrbitPivotWorld.z,
          );
          void controls.update?.(0);
        }
        return;
      }

      this.applyOrbitPivotFromModelPickLikeTap(this.lastPointerNdc, controls);
    };
    controls.addEventListener("controlstart", this.orbitPivotControlStartHandler);
  }

  /**
   * Wheel-zoom is the user's "I want to look at this" gesture — same status as picking an
   * element. `camera-controls` never fires `controlstart` for wheel events (only the generic
   * `control` event), so the {@link orbitPivotControlStartHandler} cannot catch it.
   *
   * Two non-obvious constraints shaped this listener:
   *
   * 1. **Register on `window` with capture phase**, not on the canvas. Listeners on the same
   *    DOM target fire in registration order, and `camera-controls` registers its wheel
   *    handler before we get the chance — so a capture-phase listener on the same canvas does
   *    not actually run earlier. Registering on `window` lets us run during the capture
   *    descent, before any element-level listener (ours or library-owned) fires.
   *
   * 2. **Do NOT call `setOrbitPoint(hit)` here.** That helper internally calls
   *    `dollyTo(distanceFromCameraToHit, false)` which writes `_sphericalEnd.radius` and
   *    `_spherical.radius` — overwriting the new radius `camera-controls` just set from the
   *    wheel and effectively cancelling the zoom. We only need to refresh the stored pivot;
   *    the next rotation's `orbitPivotControlStartHandler` will call `setOrbitPoint` once the
   *    camera has settled at the post-zoom position, computing the correct radius then.
   */
  private installPerspectiveWheelPivotReseed(): void {
    const canvas = this.world.renderer?.three?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;

    this.wheelDollyPivotReseedHandler = (event: WheelEvent) => {
      if (this.disposed || this.activeOrthoViewMode !== null) return;
      const cam = this.world.camera.three;
      if (!cam || !(cam as THREE.PerspectiveCamera).isPerspectiveCamera) return;

      const tn = event.target;
      if (!(tn instanceof Node) || (tn !== canvas && !canvas.contains(tn))) return;

      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      this.wheelDollyPivotNdc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );

      const fresh = this.tryFreshPivotFromCursor(this.wheelDollyPivotNdc);
      if (!fresh) return;

      this.pickOrbitPivotWorld.copy(fresh);
      this.pickOrbitPivotActive = true;
    };

    window.addEventListener("wheel", this.wheelDollyPivotReseedHandler, {
      capture: true,
      passive: true,
    });
  }

  private installOrthoViewZoomTowardCursor(): void {
    const canvas = this.world.renderer?.three?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;

    this.orthoViewWheelCaptureHandler = (e: WheelEvent) => {
      if (this.disposed || this.activeOrthoViewMode === null) return;

      const ctrl = this.world.camera.controls as CameraControls | undefined;
      const cam = this.world.camera.three;
      if (!ctrl?.enabled || cam.type !== "OrthographicCamera") return;

      const tn = e.target;
      if (!(tn instanceof Node) || (tn !== canvas && !canvas.contains(tn))) return;

      const ortho = cam as THREE.OrthographicCamera;

      const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
      const deltaYFactor = isMac ? -1 : -3;
      const delta =
        e.deltaMode === 1 && !e.ctrlKey ? e.deltaY / deltaYFactor : e.deltaY / (deltaYFactor * 10);
      const zoomScale = Math.pow(0.95, -delta * ctrl.dollySpeed);
      if (!Number.isFinite(zoomScale)) return;

      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      void ctrl.update(0);
      ortho.updateMatrixWorld(true);

      const prevZoom = ortho.zoom;
      const nextZoom = THREE.MathUtils.clamp(prevZoom * zoomScale, ctrl.minZoom, ctrl.maxZoom);
      if (Math.abs(nextZoom - prevZoom) < 1e-10) return;

      const zDepth = (ortho.near + ortho.far) / (ortho.near - ortho.far);
      this.orthoWheelWorldCursor.set(mx, my, zDepth);
      this.orthoWheelWorldCursor.unproject(ortho);
      this.orthoWheelAx.set(0, 0, -1).applyQuaternion(ortho.quaternion);
      const cursor = this.orthoWheelCursorProj
        .copy(this.orthoWheelWorldCursor)
        .add(this.orthoWheelAx.multiplyScalar(-this.orthoWheelWorldCursor.dot(ortho.up)));

      ctrl.getTarget(this.orthoWheelTargetSnap);
      (ctrl as CameraControlsOrbital)._getCameraDirection(this.orthoWheelCamDir);

      const prevPlane = this.orthoWheelTargetSnap.dot(this.orthoWheelCamDir);
      const lerpRatio = (nextZoom - prevZoom) / nextZoom;
      const newTarget = this.orthoWheelNewTarget
        .copy(this.orthoWheelTargetSnap)
        .lerp(cursor, lerpRatio);
      const pull = newTarget.dot(this.orthoWheelCamDir) - prevPlane;
      newTarget.sub(this.orthoWheelAx.copy(this.orthoWheelCamDir).multiplyScalar(pull));

      e.preventDefault();
      e.stopImmediatePropagation();

      void ctrl.zoomTo(nextZoom, false);
      void ctrl.moveTo(newTarget.x, newTarget.y, newTarget.z, false);
      void ctrl.stop?.();
      void ctrl.update(0);
    };

    this.container.addEventListener("wheel", this.orthoViewWheelCaptureHandler, {
      capture: true,
      passive: false,
    });
  }

  /**
   * Seed a fresh sticky orbit pivot from the current cursor position using only the **sync** raycast
   * path (OBC raycaster + CPU mesh intersect; sticky pivot / model centroid otherwise).
   *
   * Intentionally does not chain to an async `getFullPick`: a late GPU result arriving mid-rotate
   * would snap the pivot, which is exactly the inconsistency the picked-element path avoids. The
   * sync path is precise enough on the current frame and stays stable for the entire gesture.
   */
  private applyOrbitPivotFromModelPickLikeTap(ndc: THREE.Vector2, controls: CameraControls): void {
    const pSync = this.worldOrbitPointFromPerspectiveNdc(ndc.clone());
    this.pickOrbitPivotWorld.copy(pSync);
    this.pickOrbitPivotActive = true;
    void controls.stop?.();
    controls.setOrbitPoint(pSync.x, pSync.y, pSync.z);
    void controls.update?.(0);
  }

  /**
   * Same coarse ray path as measurement — hits fragment/LOD surfaces synchronously so canvas
   * orbit/zoom pivot matches a model tap without waiting on GPU `getPointAt`.
   */
  private tryWorldPointFromThatOpenRaycast(ndc: THREE.Vector2): THREE.Vector3 | null {
    if (!this.modelObject) return null;
    try {
      const raycaster = this.components.get(OBC.Raycasters).get(this.world);
      const hit = raycaster.castRayToObjects([this.modelObject], ndc);
      if (hit?.point) return hit.point.clone();
    } catch {
      return null;
    }
    return null;
  }

  private meshDataToPickGeometry(mesh: MeshData): THREE.BufferGeometry | null {
    if (!mesh.positions || mesh.positions.length < 9) return null;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(mesh.positions), 3));
    if (mesh.indices && mesh.indices.length >= 3) {
      const index = mesh.indices instanceof Uint32Array ? mesh.indices : Uint32Array.from(mesh.indices);
      geom.setIndex(new THREE.BufferAttribute(index, 1));
    }
    if (mesh.transform) geom.applyMatrix4(mesh.transform);
    geom.computeBoundingSphere();
    return geom;
  }

  private async pickPriorityLocalAtPoint(ndc: THREE.Vector2): Promise<number | null> {
    if (
      this.disposed ||
      !this.modelId ||
      !this.modelObject ||
      this.pickPriorityLocalIds.length === 0
    ) {
      return null;
    }

    const camera = this.world.camera?.three;
    if (!camera) return null;
    const fragments = this.components.get(OBC.FragmentsManager);
    const fragModel = fragments.list.get(this.modelId);
    if (!fragModel) return null;

    this.pickPriorityRaycaster.setFromCamera(ndc, camera);
    let best: { localId: number; distance: number } | null = null;
    const tempMaterial = new THREE.MeshBasicMaterial();
    try {
      for (let i = 0; i < this.pickPriorityLocalIds.length; i += 48) {
        const slice = this.pickPriorityLocalIds.slice(i, i + 48);
        let itemGeoms: MeshData[][];
        try {
          itemGeoms = await fragModel.getItemsGeometry(slice, FRAGMENTS_LOD_GEOMETRY);
        } catch {
          continue;
        }

        for (let j = 0; j < slice.length; j++) {
          const localId = slice[j];
          for (const md of itemGeoms[j] ?? []) {
            const geom = this.meshDataToPickGeometry(md);
            if (!geom) continue;
            const mesh = new THREE.Mesh(geom, tempMaterial);
            mesh.matrixWorld.copy(this.modelObject.matrixWorld);
            mesh.matrixAutoUpdate = false;
            const hit = this.pickPriorityRaycaster.intersectObject(mesh, false)[0];
            geom.dispose();
            if (!hit) continue;
            if (!best || hit.distance < best.distance) {
              best = { localId, distance: hit.distance };
            }
          }
        }
      }
    } finally {
      tempMaterial.dispose();
    }

    return best?.localId ?? null;
  }

  /** Meshes whose `position` buffer exists on CPU — avoids fragment tiles that throw in BVH raycast. */
  private collectMeshesWithCpuPosition(root: THREE.Object3D): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    root.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (!m.isMesh || !m.visible) return;
      const g = m.geometry as THREE.BufferGeometry | undefined;
      const pos = g?.attributes?.position;
      if (!pos || pos.count < 3) return;
      if (!pos.array || pos.array.length === 0) return;
      meshes.push(m);
    });
    return meshes;
  }

  /**
   * Sync raycast at `ndc` against the model. Returns the world hit only when the cursor is
   * actually over a visible surface (ThatOpen fragment raycast or CPU mesh intersect). Used by
   * the controlstart handler to re-anchor the orbit pivot to whatever the user can see under
   * their cursor at the start of every gesture — same effect as tapping that element, without
   * requiring a selection.
   *
   * Returns `null` when the cursor is over empty space so callers can decide whether to keep the
   * current sticky pivot or fall back to the model centroid.
   */
  private tryFreshPivotFromCursor(ndc: THREE.Vector2): THREE.Vector3 | null {
    const cam = this.world.camera.three;
    if (!cam || !(cam as THREE.PerspectiveCamera).isPerspectiveCamera) return null;
    if (!this.modelObject) return null;

    const thatOpenPt = this.tryWorldPointFromThatOpenRaycast(ndc);
    if (thatOpenPt) return thatOpenPt;

    try {
      const persp = cam as THREE.PerspectiveCamera;
      this.orbitPivotRaycaster.setFromCamera(ndc, persp);
      const targets = this.collectMeshesWithCpuPosition(this.modelObject);
      if (targets.length > 0) {
        const hits = this.orbitPivotRaycaster.intersectObjects(targets, false);
        if (hits.length > 0) return hits[0].point.clone();
      }
    } catch {
      /* BVH / attribute edge cases on individual meshes */
    }
    return null;
  }

  /**
   * Stable orbit pivot for canvas gestures — fallback wrapper around {@link tryFreshPivotFromCursor}.
   *
   * Order of preference:
   *   1. Fresh sync raycast hit under the cursor (fragment surface or CPU mesh).
   *   2. The current sticky pivot ({@link pickOrbitPivotWorld}) if one exists — matches the
   *      picked-element experience: cursor over empty space keeps using the last good point
   *      instead of inventing a new one from cursor-ray fallbacks.
   *   3. Model centroid (first gesture only, before any pivot has ever been seeded).
   *
   * Deliberately no bounding-sphere / view-plane / distance-along-ray fallbacks: those produced
   * three different orbit radii depending on where the cursor happened to land, which is what made
   * empty-canvas orbit feel inconsistent.
   */
  private worldOrbitPointFromPerspectiveNdc(ndc: THREE.Vector2): THREE.Vector3 {
    const fresh = this.tryFreshPivotFromCursor(ndc);
    if (fresh) return fresh;

    if (this.pickOrbitPivotActive) {
      return this.pickOrbitPivotWorld.clone();
    }

    if (this.modelObject) {
      const box = new THREE.Box3().setFromObject(this.modelObject);
      if (!box.isEmpty()) {
        return box.getCenter(this.orbitPivotScratchCenter).clone();
      }
    }
    return new THREE.Vector3();
  }

  /**
   * Fragments clip in the worker using planes from each loaded model's `getClippingPlanesEvent`.
   * Default is `() => []` — without wiring, Clipper planes never reach the fragment renderer (slider / cuts appear broken).
   * Must run only after `FragmentsManager.init()` (inside {@link loadIfcModel}); `fragments.list` throws earlier.
   */
  private ensureFragmentsClippingListeners() {
    const fragments = this.components.get(OBC.FragmentsManager);
    if (!fragments.initialized || this.fragmentsClippingListenersInstalled || this.disposed) return;
    fragments.list.onItemSet.add(() => {
      if (!this.disposed) this.syncFragmentsClippingPlanesBridge();
    });
    this.fragmentsClippingListenersInstalled = true;
  }

  private syncFragmentsClippingPlanesBridge() {
    const fragments = this.components.get(OBC.FragmentsManager);
    if (!fragments.initialized || !this.world?.renderer) return;
    const getter = () =>
      (this.world.renderer as unknown as { clippingPlanes: THREE.Plane[] }).clippingPlanes;
    for (const [, model] of fragments.list) {
      model.getClippingPlanesEvent = getter;
    }
  }

  /** Camera along `(1,1,1)` diagonal — Y‑up matches fragment IFC placement (RX −90° → vertical along +Y). */
  private frameCameraIsoDiagonal(center: THREE.Vector3, radius: number) {
    this.clearStoredPickOrbitPivot();
    const ctrl = this.world.camera.controls;
    const cam = this.world.camera.three as THREE.PerspectiveCamera;
    this.world.scene.three.up.set(0, 1, 0);
    cam.up.set(0, 1, 0);
    ctrl?.updateCameraUp();
    const dist = Math.max(radius * 1.55, 8);
    const dir = new THREE.Vector3(1, 1, 1).normalize();
    const eye = center.clone().addScaledVector(dir, dist);
    ctrl?.setLookAt(eye.x, eye.y, eye.z, center.x, center.y, center.z, false);
    ctrl?.setFocalOffset(0, 0, 0, false);
    void ctrl?.stop?.();
    void ctrl?.update?.(0);
  }

  private installFragmentCameraSyncOnce() {
    if (this.fragmentCameraHooksInstalled) return;
    const cameraComp = this.world.camera as OBC.SimpleCamera;
    cameraComp.controls?.addEventListener("rest", () => {
      const fragments = this.components.get(OBC.FragmentsManager);
      if (!fragments.initialized) return;
      void fragments.core.update(true);
    });
    cameraComp.controls?.addEventListener("update", () => {
      this.syncPerspectiveOrbitLimitsClipAndSensitivity();
      const fragments = this.components.get(OBC.FragmentsManager);
      if (!fragments.initialized) return;
      /* Default `core.update()` caps work at ~4ms; leftover tile batches look like flicker/reverts after isolation. */
      void (async () => {
        if (this.disposed) return;
        if (this.isolationVisualMode === "context") {
          /**
           * Context opacity is highly sensitive to incremental tile UPDATE churn.
           * We only force worker sync at explicit isolation steps/rest events.
           */
          return;
        }
        if (this.isolationVisualMode !== "none") {
          await fragments.core.update(true);
        } else {
          void fragments.core.update();
        }
      })();
    });
    this.fragmentCameraHooksInstalled = true;
  }

  /**
   * One-time readability pass on Three materials (fragments often ship MeshStandardMaterial clones).
   * Low metalness / mid roughness = softer industrial highlights without env maps.
   */
  private tuneReadableSteelMaterials(root: THREE.Object3D) {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!(mat instanceof THREE.MeshStandardMaterial)) continue;
        mat.metalness = Math.min(mat.metalness, 0.08);
        mat.roughness = THREE.MathUtils.clamp(mat.roughness + 0.1, 0.66, 0.85);
      }
    });
  }

  private disposeSketchEdgeMaterialPool() {
    if (this.modelObject) restoreSketchLineSegmentsUnifiedMaterialSwap(this.modelObject);
    setTechnicalSketchUnifiedStroke(false);
    this.unifiedSketchStrokeMaterial?.dispose();
    this.unifiedSketchStrokeMaterial = null;
    for (const m of this.sketchEdgeMaterialPool.values()) m.dispose();
    this.sketchEdgeMaterialPool.clear();
  }

  /**
   * Per-mode sketch edge visibility:
   * - **`isolated`**: hide every main-view sketch edge. The picked element's outline is drawn by
   *   {@link buildPickedEdgeOverlay} on top, so non-picked tile-mates can never bleed through
   *   (which would happen with `itemFilter`-based hiding because shell meshes don't carry one).
   * - **`context`**: keep edges visible — dimmed to match `CONTEXT_GHOST_FACE_OPACITY` (visual-policy) via
   *   {@link setContextIsolationEdgeOpacity} to match the ghost faces.
   * - **`hidden`** (הסתר): same rails-off strategy as **`isolated`** — LOD tile wires can still bleed
   *   full-opacity edges for neighboring instances inside a batched tile, so outlines come only from
   *   {@link buildPickedEdgeOverlay} for **visible** locals (`getItemsGeometry` per element).
   * - **`none`**: all edges visible at full opacity (live `lodColor` per element).
   */
  private syncSketchEdgeVisibilityToIsolationState(): void {
    if (!this.modelObject) return;
    if (this.isolationVisualMode === "isolated" || this.isolationVisualMode === "hidden") {
      setSketchEdgeVisibility(this.modelObject, false);
      return;
    }
    if (this.viewFilterSuppressMainSketchEdges) {
      setSketchEdgeVisibility(this.modelObject, false);
      return;
    }
    setSketchEdgeVisibility(this.modelObject, true);
  }

  private clearHiddenRemainderSketchDebounceTimer(): void {
    if (this.hiddenRemainderSketchDebounceTimer !== null) {
      clearTimeout(this.hiddenRemainderSketchDebounceTimer);
      this.hiddenRemainderSketchDebounceTimer = null;
    }
  }

  private shutdownHiddenRemainderSketchState(): void {
    this.clearHiddenRemainderSketchDebounceTimer();
    this.hiddenRemainderSketchNonce++;
    this.isolationHiddenExcludedLocals = null;
  }

  private scheduleHiddenRemainderSketchOverlayAfterTiles(): void {
    if (this.disposed || this.isolationVisualMode !== "hidden" || !this.isolationHiddenExcludedLocals?.size) {
      return;
    }
    this.clearHiddenRemainderSketchDebounceTimer();
    this.hiddenRemainderSketchDebounceTimer = setTimeout(() => {
      this.hiddenRemainderSketchDebounceTimer = null;
      if (this.disposed || this.isolationVisualMode !== "hidden") return;
      void this.enqueueIsolation(async () => {
        if (this.disposed || this.isolationVisualMode !== "hidden") return;
        this.hiddenRemainderSketchNonce++;
        const nonce = this.hiddenRemainderSketchNonce;
        await this.executeHiddenRemainderSketchOverlayRebuild(nonce);
      });
    }, 260);
  }

  private async executeHiddenRemainderSketchOverlayRebuild(expectedNonce: number): Promise<void> {
    if (this.disposed || !this.modelObject || !this.modelId) return;
    if (this.isolationVisualMode !== "hidden") return;

    const excluded = this.isolationHiddenExcludedLocals;
    if (!excluded) return;

    const fragments = this.components.get(OBC.FragmentsManager);
    if (!fragments.initialized) return;
    const fragModel = fragments.list.get(this.modelId);
    if (!fragModel) return;

    disposePickedEdgeOverlay(this.pickedEdgeOverlay);
    this.pickedEdgeOverlay = null;

    let allIds: number[];
    try {
      allIds = await this.allFragmentLocalIds(fragModel);
    } catch {
      return;
    }

    const visibleLocals = allIds.filter((id) => !excluded.has(id));
    const overlay = await buildPickedEdgeOverlay(
      fragModel,
      this.modelObject,
      visibleLocals,
      this.sketchEdgeMaterialPool,
      { yieldBetweenBatches: true },
    );

    if (
      expectedNonce !== this.hiddenRemainderSketchNonce ||
      this.isolationVisualMode !== "hidden"
    ) {
      disposeConstructedEdgeOverlayGroup(overlay);
      return;
    }

    if (overlay.children.length === 0) {
      disposeConstructedEdgeOverlayGroup(overlay);
      return;
    }

    this.pickedEdgeOverlay = overlay;
    this.modelObject.add(overlay);
    await this.syncFragmentsViewForced(fragments);
  }

  /**
   * Cached outlines once per {@link loadFile}. IFC fragments render via {@link LodMaterial};
   * we hide faces with `lodOpacity = 0` (replacing `mesh.material` is overwritten by the worker).
   */
  private rebuildSketchModeCache(): void {
    if (this.disposed || !this.modelObject) return;

    stripSketchEdgeChildren(this.modelObject);
    this.disposeSketchEdgeMaterialPool();
    this.sketchMaterialBackup.clear();
    this.sketchLodOpacityBackup.clear();
    if (this.sketchFillMaterial) {
      this.sketchFillMaterial.dispose();
      this.sketchFillMaterial = null;
    }
    this.sketchFillMaterial = createSketchFillMaterial();

    this.modelObject.traverse((obj) => {
      const mesh = obj as THREE.Mesh & THREE.InstancedMesh;
      if (!mesh.isMesh) return;
      if (mesh.name === CONTEXT_GHOST_SNAPSHOT_NAME) return;
      const geom = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geom?.attributes.position || geom.getAttribute("position").count < 3) return;
      if (!mesh.material) return;
      this.sketchMaterialBackup.set(mesh, mesh.material);
    });

    attachSketchEdges(this.modelObject, this.sketchEdgeMaterialPool);
    /** Per-element darker edge strokes; off in isolation/context (see overlay). */
    this.syncSketchEdgeVisibilityToIsolationState();
    const hadMeshes = this.sketchMaterialBackup.size > 0;
    this.sketchEdgesBuilt = hadMeshes;

    if (hadMeshes) {
      if (this.sketchModeEnabled) this.applySketchModeVisuals(true);
      else this.applySketchModeVisuals(false);
    }
  }

  /**
   * Fragment tiles keep mounting after load (`tiles.onItemSet` / `onViewUpdated`). Merge materials,
   * attach missing edge geometry, and keep outlines visible.
   */
  private syncSketchEdgesForNewTiles(opts?: { tileMount?: boolean }): void {
    if (this.disposed || !this.modelObject) return;

    let newInBackup = false;
    this.modelObject.traverse((obj) => {
      const mesh = obj as THREE.Mesh & THREE.InstancedMesh;
      if (!mesh.isMesh) return;
      if (mesh.name === CONTEXT_GHOST_SNAPSHOT_NAME) return;
      const geom = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geom?.attributes.position || geom.getAttribute("position").count < 3) return;
      if (!mesh.material) return;
      if (!this.sketchMaterialBackup.has(mesh)) {
        this.sketchMaterialBackup.set(mesh, mesh.material);
        newInBackup = true;
      }
    });

    const newEdges = ensureSketchEdgesAttached(this.modelObject, this.sketchEdgeMaterialPool);

    if (this.sketchMaterialBackup.size === 0) return;

    this.syncSketchEdgeVisibilityToIsolationState();

    const firstTimeReady = !this.sketchEdgesBuilt;
    const visualsDirty = firstTimeReady || newInBackup || newEdges > 0;
    if (firstTimeReady) {
      this.sketchEdgesBuilt = true;
    }
    if (visualsDirty) {
      this.applySketchModeVisuals(this.sketchModeEnabled);
    }
    if (opts?.tileMount && this.isolationVisualMode === "hidden") {
      this.scheduleHiddenRemainderSketchOverlayAfterTiles();
    }
  }

  private detachSketchTilesListener() {
    this.sketchTilesUnsub?.();
    this.sketchTilesUnsub = null;
  }

  /**
   * Tiles stream onto `model.object` after load. Sync sketch edges on every view pass **and** on
   * each tile mount so outlines are not dropped when `onViewUpdated` alone misses batches.
   */
  private attachSketchRebuildWhenTilesReady(fragModel: FragmentsModel) {
    this.detachSketchTilesListener();

    const cleanup = () => {
      fragModel.onViewUpdated.remove(onViewUpdated);
      fragModel.tiles.onItemSet.remove(onTileSet);
      this.sketchTilesUnsub = null;
    };

    const onViewUpdated = () => {
      if (this.disposed) {
        cleanup();
        return;
      }
      this.syncSketchEdgesForNewTiles();
    };

    const onTileSet = () => {
      if (this.disposed) return;
      queueMicrotask(() => {
        if (!this.disposed) this.syncSketchEdgesForNewTiles({ tileMount: true });
      });
    };

    fragModel.onViewUpdated.add(onViewUpdated);
    fragModel.tiles.onItemSet.add(onTileSet);
    this.sketchTilesUnsub = cleanup;
  }

  private applySketchModeVisuals(enabled: boolean): void {
    if (!this.modelObject) return;

    if (enabled) {
      const fill = this.sketchFillMaterial;
      this.modelObject.traverse((obj) => {
        const mesh = obj as THREE.Mesh & THREE.InstancedMesh;
        if (!mesh.isMesh) return;
        const orig = this.sketchMaterialBackup.get(mesh);
        if (orig === undefined) return;

        const origList = Array.isArray(orig) ? orig : [orig];
        if (origList.length === 0) return;

        if (origList.every(isLodFragmentMaterial)) {
          for (const m of origList) {
            if (!isLodFragmentMaterial(m)) continue;
            const mat = m as THREE.Material & { lodOpacity: number };
            if (!this.sketchLodOpacityBackup.has(m)) this.sketchLodOpacityBackup.set(m, mat.lodOpacity);
            mat.lodOpacity =
              this.inspectionPresentationActive && this.inspectionIsolationSketchReadable
                ? INSPECTION_SKETCH_LOD_FACE_OPACITY
                : 0;
          }
        } else {
          if (!fill) return;
          mesh.material = Array.isArray(orig) ? origList.map(() => fill) : fill;
        }
      });

      setTechnicalSketchUnifiedStroke(true);
      if (!this.unifiedSketchStrokeMaterial) {
        this.unifiedSketchStrokeMaterial = createTechnicalSketchLineBasicMaterial();
      }
      swapSketchLineSegmentsToUnifiedMaterial(this.modelObject, this.unifiedSketchStrokeMaterial);

      this.syncSketchEdgeVisibilityToIsolationState();
    } else {
      setTechnicalSketchUnifiedStroke(false);
      restoreSketchLineSegmentsUnifiedMaterialSwap(this.modelObject);

      for (const [mat, opacity] of this.sketchLodOpacityBackup) {
        (mat as THREE.Material & { lodOpacity: number }).lodOpacity = opacity;
      }
      this.sketchLodOpacityBackup.clear();

      this.modelObject.traverse((obj) => {
        const mesh = obj as THREE.Mesh & THREE.InstancedMesh;
        if (!mesh.isMesh) return;
        const orig = this.sketchMaterialBackup.get(mesh);
        if (orig === undefined) return;
        const origList = Array.isArray(orig) ? orig : [orig];
        if (!origList.every(isLodFragmentMaterial)) mesh.material = orig;
      });

      /** CAD edges stay on for default shaded view (same geometry as sketch mode; zero extra load). */
      this.syncSketchEdgeVisibilityToIsolationState();
    }

    const fragments = this.components.get(OBC.FragmentsManager);
    if (fragments.initialized) void fragments.core.update(true);
  }

  /** Sketch: transparent LOD faces + technical dark-gray strokes; off: solid shading + IFC-tinted edge cache restored. */
  setSketchMode(enabled: boolean): void {
    if (this.disposed) return;
    if (this.sketchModeEnabled === enabled) return;
    this.sketchModeEnabled = enabled;
    if (!this.modelObject || !this.sketchEdgesBuilt) return;
    this.applySketchModeVisuals(enabled);
  }

  /**
   * Same as {@link setSketchMode} but skips the internal equality short‑circuit so UI toggles always apply.
   */
  setSketchModeFromUI(enabled: boolean): void {
    if (this.disposed) return;
    this.sketchModeEnabled = enabled;
    if (!this.modelObject || !this.sketchEdgesBuilt) return;
    this.applySketchModeVisuals(enabled);
  }

  /**
   * One global clipping plane for IFC fragments (`renderer.setPlane` + worker bridge).
   * If an orthographic preset (מבט / הצג כחתך) is active, restores perspective so clearing
   * clipping does not leave the camera in ortho.
   */
  clearClipping(): void {
    if (this.disposed) return;
    if (this.userClippingActive) {
      const rw = this.world.renderer as OBF.RendererWith2D;
      rw.setPlane(false, this.userClipPlane, false);
      rw.updateClippingPlanes();
    }
    this.userClippingActive = false;
    this.userClipDirection = null;
    this.userClipFlipped = false;
    this.userClipDepthOffset = 0;
    if (this.activeOrthoViewMode !== null) {
      this.exitViewMode();
    }
  }

  enableClippingDirection(direction: ClippingDirectionId): void {
    if (this.disposed || !this.modelObject) return;
    const box = new THREE.Box3().setFromObject(this.modelObject);
    if (box.isEmpty()) return;

    box.getCenter(this.userClipCenter);
    const size = box.getSize(new THREE.Vector3());
    this.userClipDiagonal = Math.max(size.length(), 1e-6);

    this.userClipDirection = direction;
    this.userClipFlipped = false;
    this.userClipDepthOffset = 0;
    this.userClippingActive = true;
    this.applyUserClippingToRenderer();
  }

  setClippingDepthOffset(offset: number): void {
    if (this.disposed || !this.userClippingActive) return;
    const half = this.userClipDiagonal / 2;
    this.userClipDepthOffset = THREE.MathUtils.clamp(offset, -half, half);
    this.applyUserClippingToRenderer();
  }

  flipClipping(): void {
    if (this.disposed || !this.userClippingActive) return;
    this.userClipFlipped = !this.userClipFlipped;
    this.applyUserClippingToRenderer();
  }

  getClippingUiSnapshot(): ViewerClippingUiSnapshot {
    const half = this.userClipDiagonal / 2;
    return {
      active: this.userClippingActive,
      direction: this.userClipDirection,
      labelHe: this.userClipDirection ? CLIPPING_LABELS_HE[this.userClipDirection] : null,
      depthOffset: this.userClipDepthOffset,
      depthMin: -half,
      depthMax: half,
      flipped: this.userClipFlipped,
    };
  }

  /** Three.js canvas (3D view only — UI lives in separate layers). */
  getViewCanvas(): HTMLCanvasElement | null {
    const el = this.world?.renderer?.three?.domElement;
    return el instanceof HTMLCanvasElement ? el : null;
  }

  private applyUserClippingToRenderer(): void {
    if (this.disposed || !this.userClippingActive || !this.modelObject || !this.userClipDirection) return;

    const n = normalForClippingDirection(this.userClipDirection, this.tmpClipNormal);
    if (this.userClipFlipped) n.negate();
    n.normalize();

    this.userClipPlane.normal.copy(n);
    // Through center + n*depthOffset along plane normal (world units).
    this.userClipPlane.constant = -n.dot(this.userClipCenter) - this.userClipDepthOffset;

    const rw = this.world.renderer as OBF.RendererWith2D;
    rw.setPlane(true, this.userClipPlane, false);
    rw.updateClippingPlanes();
  }

  async loadFile(file: File) {
    if (this.disposed) return;
    await this.clearIsolationVisuals();
    this.clearClipping();
    this.detachSketchTilesListener();
    if (this.activeOrthoViewMode !== null) this.exitViewMode();
    this.measurementController.clearAll();
    const { model } = await loadIfcModel(this.components, file);
    this.ensureFragmentsClippingListeners();
    const casted = model as {
      modelId: string;
      object: THREE.Object3D;
      useCamera: (cam: THREE.PerspectiveCamera | THREE.OrthographicCamera) => void;
    };
    if (this.modelObject) {
      this.clearContextMainThreadVisuals();
      stripSketchEdgeChildren(this.modelObject);
      this.sketchMaterialBackup.clear();
      this.sketchLodOpacityBackup.clear();
      if (this.sketchFillMaterial) {
        this.sketchFillMaterial.dispose();
        this.sketchFillMaterial = null;
      }
      this.disposeSketchEdgeMaterialPool();
      this.sketchEdgesBuilt = false;
      this.world.scene.three.remove(this.modelObject);
    }
    this.modelObject = casted.object;
    this.modelId = casted.modelId;
    this.analyzerGuidKeyToFragmentLocal.clear();
    this.world.scene.three.add(casted.object);
    this.refreshCameraSensitivityRefFromModel();

    this.boundUseCamera = casted.useCamera.bind(casted);
    const cam = this.world.camera.three as THREE.PerspectiveCamera;
    this.boundUseCamera(cam);

    const fragments = this.components.get(OBC.FragmentsManager);
    void fragments.core.update(true);

    const fragModel = fragments.list.get(casted.modelId);
    if (fragModel) {
      await fragModel.setLodMode(LodMode.ALL_VISIBLE);
    }

    this.applyPerspectiveClipPlanes(casted.object);

    this.tuneReadableSteelMaterials(casted.object);

    this.rebuildSketchModeCache();

    if (fragModel) {
      this.attachSketchRebuildWhenTilesReady(fragModel);
    }

    requestAnimationFrame(() => {
      if (!this.disposed && this.modelObject) {
        this.syncSketchEdgesForNewTiles();
      }
    });

    this.syncFragmentsClippingPlanesBridge();
    this.fitAll();
  }

  getModelId() {
    return this.modelId;
  }

  setPickCallback(cb: ((hit: PickHit | null) => void) | null) {
    this.pickCallback = cb;
  }

  async pickAtClientPoint(clientX: number, clientY: number): Promise<PickHit | null> {
    if (this.disposed || this.isInspectionVisualizationSessionActive()) return null;
    const canvas = this.world.renderer?.three?.domElement as HTMLCanvasElement | undefined;
    const camera = this.world.camera;
    if (!canvas || !camera?.three) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) {
      return null;
    }

    const mouse = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );

    try {
      const pickers = this.components.get(OBC.FastModelPickers);
      const picker = pickers.get(this.world);
      const full = await picker.getFullPick(mouse);
      if (!full || typeof full.localId !== "number") return null;
      return {
        localId: full.localId,
        itemId: full.itemId,
        clientX,
        clientY,
        button: 0,
        ctrlKey: false,
      };
    } catch {
      return null;
    }
  }

  setPickPriorityLocalIds(
    localIds: Iterable<number>,
    mode: "all" | "right-click" = "all",
  ) {
    this.pickPriorityLocalIds = [...new Set(localIds)].filter((n) => Number.isFinite(n));
    this.pickPriorityMode = mode;
  }

  /**
   * Viewport looks like phone/tablet or Chrome DevTools device toolbar — still sends `pointerType: "mouse"`.
   * Without this, measurement waits for pointerup like desktop, which often breaks under emulation.
   */
  private compactViewportLikePhoneOrDevTools(): boolean {
    if (typeof window === "undefined") return false;
    const iw = window.visualViewport?.width ?? window.innerWidth;
    const ih = window.visualViewport?.height ?? window.innerHeight;
    return iw <= 1366 || ih <= 860 || Math.min(iw, ih) <= 900;
  }

  /** Primary pointer should place a measurement point on pointerdown (not only after pointerup). */
  private shouldInstantMeasurementTap(e: PointerEvent): boolean {
    if (!e.isPrimary) return false;
    if (e.pointerType === "touch" || e.pointerType === "pen") return true;
    if (
      !e.pointerType &&
      typeof navigator !== "undefined" &&
      navigator.maxTouchPoints > 0
    ) {
      return true;
    }
    /* Matches measurement profile — catches pointers typed oddly as `mouse` on some tablets/WebViews. */
    if (MeasurementController.prefersTouchLikeMeasurement()) return true;
    if (typeof window === "undefined") return false;
    if (window.matchMedia("(pointer: coarse)").matches && e.pointerType !== "mouse") {
      return true;
    }
    if (e.pointerType === "mouse" && this.compactViewportLikePhoneOrDevTools()) {
      return true;
    }
    return false;
  }

  /**
   * Arm tap-to-pick only when the pointer is over the WebGL canvas rect and not on app chrome.
   * Renderer siblings (e.g. CSS2D root) may be the event target even though the hit is visually on the model.
   */
  private pointerDownArmsModelTap(event: PointerEvent, canvas: HTMLCanvasElement): boolean {
    const t = event.target;
    if (t instanceof HTMLElement) {
      if (
        t.closest(
          "button,a[href],input,textarea,select,label,[role='button'],[role='menuitem'],[role='tab']",
        )
      ) {
        return false;
      }
    }
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX;
    const y = event.clientY;
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return false;
    if (t === canvas) return true;
    const host = canvas.parentElement;
    if (!(t instanceof Node) || !host?.contains(t)) return false;
    if (t instanceof Element && t.closest("[data-eyeSteel-measure-labels]")) return false;
    return true;
  }

  /** Keeps taps usable during measurement — disabling CameraControls avoids doc-level `pointermove` + `preventDefault` while bindings are NONE. */
  private reinstateCanvasTouchBlocking() {
    const canvas = this.world.renderer?.three?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;
    canvas.style.touchAction = "none";
    const host = canvas.parentElement;
    if (host) host.style.touchAction = "none";
  }

  /**
   * Activates/deactivates מצב מדידה. On exit from measurement: clears overlays/lines while preserving
   * the current camera pose exactly where the user left it.
   */
  setViewerTool(tool: ViewerToolMode): ViewerCameraRevertSnapshot | undefined {
    if (this.disposed) return undefined;
    const prevTool = this.viewerTool;
    const ctrl = this.world.camera.controls;

    if (tool === "measurement") {
      if (prevTool !== "measurement") this.measurementSessionCameraRevert = null;
      this.viewerTool = tool;
      if (ctrl && MeasurementController.prefersTouchLikeMeasurement()) {
        this.measurementControlsEnabledSnapshot = ctrl.enabled;
        ctrl.enabled = false;
        this.measurementSuppressedControls = true;
      }
      this.reinstateCanvasTouchBlocking();
      this.measurementController.activate();
    } else {
      if (prevTool === "measurement") {
        this.measurementController.clearAll();
        this.measurementSessionCameraRevert = null;
      }
      this.viewerTool = tool;
      this.measurementController.deactivate();
      if (ctrl && this.measurementSuppressedControls) {
        ctrl.enabled = this.measurementControlsEnabledSnapshot;
        this.measurementSuppressedControls = false;
      }
    }
    return undefined;
  }

  getViewerTool(): ViewerToolMode {
    return this.viewerTool;
  }

  /**
   * Clears overlays, badges, revert snapshot, and measurement tool WITHOUT moving the camera.
   * Use when crossing מצב בדיקה ↔ model so the inspection bundle stays the only authority on pose.
   */
  discardMeasurementWorkspaceKeepCamera(): void {
    if (this.disposed) return;
    this.measurementSessionCameraRevert = null;
    this.measurementController.clearAll();
    if (this.viewerTool === "measurement") {
      const ctrl = this.world.camera.controls;
      if (ctrl && this.measurementSuppressedControls) {
        ctrl.enabled = this.measurementControlsEnabledSnapshot;
        this.measurementSuppressedControls = false;
      }
      this.measurementController.deactivate();
      this.viewerTool = "none";
    } else {
      this.measurementController.deactivate();
    }
  }

  clearMeasurements() {
    if (this.disposed) return;
    this.measurementController.clearAll();
  }

  /** Measurement taps on touch/pencil — commit on pointerdown so we don't rely on pointerup (often broken / paired incorrectly on mobile). */
  private commitMeasurementTap(canvas: HTMLCanvasElement, clientX: number, clientY: number, pe: PointerEvent) {
    // Only suppress synthetic mouse after real touch/pen — compact viewport uses real mouse in DevTools;
    // suppressing mouse here skipped canvas pointerdown → no downPos → picks never ran on pointerup.
    if (pe.pointerType === "touch" || pe.pointerType === "pen") {
      this.suppressPrimaryMouseDownUntilMs = Date.now() + 450;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    void this.measurementController.tapCommit(ndc);
  }

  private installPointerListeners() {
    const canvas = this.world.renderer?.three?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;

    canvas.style.touchAction = "none";
    const host = canvas.parentElement;
    if (host) host.style.touchAction = "none";

    const syncNdc = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      this.lastPointerNdc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    const syncNdcFromClient = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      this.lastPointerNdc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    this.hostMeasurePointerDownCapture = (event: PointerEvent) => {
      if (this.disposed) return;
      if (this.viewerTool !== "measurement") return;
      if (!this.shouldInstantMeasurementTap(event)) return;
      const { clientX: x, clientY: y } = event;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return;
      syncNdcFromClient(x, y);
      this.commitMeasurementTap(canvas, x, y, event);
    };
    this.container.addEventListener("pointerdown", this.hostMeasurePointerDownCapture, true);

    this.pointerMoveHandler = (event: PointerEvent) => {
      syncNdc(event);
      if (!this.disposed && this.viewerTool === "measurement") {
        this.measurementController.scheduleHoverPick(this.lastPointerNdc.clone());
      }
    };

    this.pointerDownHandler = (event: PointerEvent) => {
      /*
       * Window capture runs before descendant listeners. Require pointer inside the WebGL rect; accept
       * targets other than the canvas (CSS2D/sibling layers sit above the canvas but belong to the viewer).
       * Strict `target === canvas` broke desktop when clicks hit those overlays.
       */
      if (!this.pointerDownArmsModelTap(event, canvas)) return;

      syncNdc(event);
      if (event.pointerType === "mouse" && event.button !== 0 && event.button !== 2) return;
      if (
        event.pointerType === "mouse" &&
        event.isPrimary &&
        Date.now() < this.suppressPrimaryMouseDownUntilMs
      ) {
        return;
      }

      /* Instant measurement picks use container capture (see hostMeasurePointerDownCapture). */
      if (this.viewerTool === "measurement" && this.shouldInstantMeasurementTap(event)) {
        return;
      }

      this.downPos = {
        x: event.clientX,
        y: event.clientY,
        t: Date.now(),
        pointerType: event.pointerType,
        button: event.button,
        ctrlKey: event.ctrlKey,
      };
    };

    this.pointerCancelHandler = () => {
      this.downPos = null;
    };

    this.pointerUpHandler = async (event: PointerEvent) => {
      if (!this.downPos) return;
      const dx = event.clientX - this.downPos.x;
      const dy = event.clientY - this.downPos.y;
      const dt = Date.now() - this.downPos.t;
      const start = this.downPos;
      this.downPos = null;

      const ptr = start.pointerType || event.pointerType;
      const touchLike = ptr === "touch" || ptr === "pen";
      const tapSlopSq = touchLike ? TAP_SLOP_SQ_TOUCH : TAP_SLOP_SQ_MOUSE;
      const tapMaxMs = touchLike ? TAP_MAX_MS_TOUCH : TAP_MAX_MS_MOUSE;

      const distSq = dx * dx + dy * dy;
      const isTap = distSq <= tapSlopSq && dt <= tapMaxMs;
      if (!isTap) return;

      const renderer = this.world.renderer;
      const camera = this.world.camera;
      if (!renderer?.three || !camera?.three) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const useX = event.clientX || start.x;
      const useY = event.clientY || start.y;
      const pickButton = start.button;
      const pickCtrlKey = start.ctrlKey || event.ctrlKey;

      if (this.viewerTool === "measurement") {
        this.commitMeasurementTap(canvas, useX, useY, event);
        return;
      }

      /** מצב בדיקה: no model picks — drilling into bolts/sub-features would re-isolate and hide the part. */
      if (this.isInspectionVisualizationSessionActive()) return;

      if (!this.pickCallback) return;

      const mouse = new THREE.Vector2(
        ((useX - rect.left) / rect.width) * 2 - 1,
        -((useY - rect.top) / rect.height) * 2 + 1,
      );
      let hit: PickHit | null = null;
      try {
        const shouldUsePriorityPick =
          this.pickPriorityLocalIds.length > 0 &&
          (this.pickPriorityMode === "all" || pickButton === 2);
        const priorityLocalId = shouldUsePriorityPick
          ? await this.pickPriorityLocalAtPoint(mouse)
          : null;
        if (priorityLocalId != null) {
          hit = {
            localId: priorityLocalId,
            itemId: priorityLocalId,
            clientX: useX,
            clientY: useY,
            button: pickButton,
            ctrlKey: pickCtrlKey,
          };
        }
      } catch (error) {
        console.error("[picker] selected-first pick failed:", error);
      }

      try {
        if (hit) {
          this.pickCallback(hit);
          return;
        }
        const pickers = this.components.get(OBC.FastModelPickers);
        const picker = pickers.get(this.world);
        const full = await picker.getFullPick(mouse);
        if (full && typeof full.localId === "number") {
          hit = {
            localId: full.localId,
            itemId: full.itemId,
            clientX: useX,
            clientY: useY,
            button: pickButton,
            ctrlKey: pickCtrlKey,
          };
          this.pickOrbitPivotWorld.copy(full.point);
          this.pickOrbitPivotActive = true;
          const c = this.world.camera.controls;
          if (c) {
            void (c as CameraControls).stop?.();
            c.setOrbitPoint(full.point.x, full.point.y, full.point.z);
            void c.update?.(0);
          }
        }
        /**
         * Miss-tap deliberately does not clear the sticky pivot — keeping it makes empty-canvas
         * orbit/pan/dolly behave identically to the picked-element case (single stable pivot per
         * camera pose). Pivot is invalidated only on programmatic camera teleports (resetView,
         * applyViewMode, restoreCameraRevertSnapshot, focusBboxMap).
         */
      } catch (error) {
        console.error("[picker] gpu pick failed:", error);
        return;
      }

      if (!hit && pickButton === 2) {
        return;
      }

      try {
        this.pickCallback(hit);
      } catch (error) {
        console.error("[picker] callback failed:", error);
      }
    };

    window.addEventListener("pointerdown", this.pointerDownHandler, true);
    canvas.addEventListener("pointermove", this.pointerMoveHandler);
    canvas.addEventListener("pointerup", this.pointerUpHandler, true);
    canvas.addEventListener("pointercancel", this.pointerCancelHandler, true);
    window.addEventListener("pointerup", this.pointerUpHandler, true);
    window.addEventListener("pointercancel", this.pointerCancelHandler, true);
  }

  private removePointerListeners() {
    const canvas = this.world.renderer?.three?.domElement as HTMLCanvasElement | undefined;
    if (this.pointerDownHandler) {
      window.removeEventListener("pointerdown", this.pointerDownHandler, true);
    }
    if (this.pointerMoveHandler) {
      canvas?.removeEventListener("pointermove", this.pointerMoveHandler);
    }
    if (this.pointerUpHandler) {
      canvas?.removeEventListener("pointerup", this.pointerUpHandler, true);
      window.removeEventListener("pointerup", this.pointerUpHandler, true);
    }
    if (this.pointerCancelHandler) {
      canvas?.removeEventListener("pointercancel", this.pointerCancelHandler, true);
      window.removeEventListener("pointercancel", this.pointerCancelHandler, true);
    }
    if (this.hostMeasurePointerDownCapture) {
      this.container.removeEventListener("pointerdown", this.hostMeasurePointerDownCapture, true);
      this.hostMeasurePointerDownCapture = null;
    }
    this.pointerDownHandler = null;
    this.pointerMoveHandler = null;
    this.pointerUpHandler = null;
    this.pointerCancelHandler = null;
    this.downPos = null;
    this.pickCallback = null;
  }

  /**
   * Maps analyzer rows (GlobalId + optional legacy express id) to the fragment local ids
   * ThatOpen uses for highlight/focus (via {@link OBC.FragmentsManager.guidsToModelIdMap}).
   */
  private async modelIdMapForAnalyzerEntities(
    entities: Iterable<{ id: string; expressId: number | null }>,
  ): Promise<Record<string, Set<number>>> {
    if (!this.modelId) return {};
    const fragments = this.components.get(OBC.FragmentsManager);
    const fragModel = fragments.list.get(this.modelId);
    const list = [...entities];
    const set = new Set<number>();
    for (const e of list) {
      const nk = normalizeIfcGuidKey(e.id);
      if (nk) {
        const fromIdx = this.analyzerGuidKeyToFragmentLocal.get(nk);
        if (fromIdx != null && Number.isFinite(fromIdx)) {
          set.add(fromIdx);
        }
      }
      if (e.expressId != null && Number.isFinite(e.expressId)) {
        set.add(e.expressId);
      }
    }
    const guids = [...new Set(list.map((e) => e.id).filter((g) => g.length > 0))];
    const fromGuids =
      guids.length > 0 ? await fragments.guidsToModelIdMap(guids) : ({} as Record<string, Set<number>>);
    for (const id of fromGuids[this.modelId] ?? []) {
      set.add(id);
    }
    if (fragModel) {
      for (const e of list) {
        const nk = normalizeIfcGuidKey(e.id);
        if (!nk || this.analyzerGuidKeyToFragmentLocal.has(nk)) continue;
        for (const v of expandIfcGuidLookupVariants(e.id)) {
          try {
            const [loc] = await fragModel.getLocalIdsByGuids([v]);
            if (typeof loc === "number" && Number.isFinite(loc)) {
              this.analyzerGuidKeyToFragmentLocal.set(nk, loc);
              set.add(loc);
              break;
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { [this.modelId]: set };
  }

  /**
   * Recursively read ThatOpen {@link FragmentsModel.getItemsData} trees (relation + attribute blobs)
   * so picks on nested geometry map back to parent IFC products the analyzer knows about.
   */
  private collectIdsAndGuidsFromItemDataRoot(
    roots: unknown[],
    localIds: Set<number>,
    guids: Set<string>,
    maxNodes: number,
  ): void {
    let steps = 0;
    const visit = (node: unknown): void => {
      if (steps >= maxNodes) return;
      if (node === null || node === undefined) return;
      steps++;
      if (Array.isArray(node)) {
        for (const x of node) visit(x);
        return;
      }
      if (typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      const lidRaw = o._localId;
      if (lidRaw && typeof lidRaw === "object" && lidRaw !== null && "value" in lidRaw) {
        const v = (lidRaw as { value: unknown }).value;
        if (typeof v === "number" && Number.isFinite(v)) {
          localIds.add(v);
        }
      }
      const guidRaw = o._guid;
      if (guidRaw && typeof guidRaw === "object" && guidRaw !== null && "value" in guidRaw) {
        const g = (guidRaw as { value: unknown }).value;
        if (typeof g === "string" && g.length > 0) guids.add(g);
      }
      for (const [k, v] of Object.entries(o)) {
        if (k === "_category") continue;
        visit(v);
      }
    };
    for (const r of roots) visit(r);
  }

  /** Resolve GPU pick ids to localIds + GUIDs, including parent/aggregate products when the hit is on child geometry. */
  async resolvePickMatchContext(hit: PickHit): Promise<{ localIds: number[]; guids: string[] }> {
    const seeds = [
      ...new Set(
        [hit.localId, hit.itemId].filter((x): x is number => typeof x === "number"),
      ),
    ];
    const fragments = this.components.get(OBC.FragmentsManager);
    const model = this.modelId ? fragments.list.get(this.modelId) : null;
    if (!model || seeds.length === 0) {
      return { localIds: seeds, guids: [] };
    }

    const localIdSet = new Set<number>(seeds);
    const guidSet = new Set<string>();

    try {
      const rows = await model.getItems(seeds);
      for (const id of seeds) {
        const row = rows.get(id);
        const g = row?.guid;
        if (typeof g === "string" && g.length > 0) guidSet.add(g);
      }
    } catch {
      /* getItems can fail for transient ids */
    }

    try {
      const fromPick = await model.getGuidsByLocalIds(seeds);
      for (const g of fromPick) {
        if (typeof g === "string" && g.length > 0) guidSet.add(g);
      }
    } catch {
      /* ignore */
    }

    try {
      const relConfig = {
        attributesDefault: true,
        relationsDefault: { attributes: false, relations: false },
        relations: {
          Decomposes: { attributes: true, relations: false },
          IsDecomposedBy: { attributes: true, relations: false },
          Nests: { attributes: true, relations: false },
          ContainedInStructure: { attributes: true, relations: false },
        },
      };
      const dataRows = await model.getItemsData(seeds, relConfig);
      this.collectIdsAndGuidsFromItemDataRoot(dataRows, localIdSet, guidSet, 120);
    } catch {
      /* ignore relation expansion */
    }

    // Second pass: resolve GUIDs for newly discovered local ids (often the owning IfcProduct)
    const extraLocals = [...localIdSet].filter((id) => !seeds.includes(id));
    if (extraLocals.length > 0) {
      try {
        const more = await model.getGuidsByLocalIds(extraLocals.slice(0, 64));
        for (const g of more) {
          if (typeof g === "string" && g.length > 0) guidSet.add(g);
        }
      } catch {
        /* ignore */
      }
    }

    return { localIds: [...localIdSet], guids: [...guidSet] };
  }

  getAnalyzerGuidIndex(): ReadonlyMap<string, number> {
    return this.analyzerGuidKeyToFragmentLocal;
  }

  /**
   * Pre-resolve every analyzer GlobalId to ThatOpen local ids so picks + highlights stay aligned.
   * Cheap one-time pass after IFC + JSON analysis are both loaded.
   */
  async syncAnalyzerGuidIndex(data: AnalyzerOutput | null): Promise<void> {
    this.analyzerGuidKeyToFragmentLocal.clear();
    if (!data || !this.modelId) return;
    const fragments = this.components.get(OBC.FragmentsManager);
    const model = fragments.list.get(this.modelId);
    if (!model) return;

    const unique = new Set<string>();
    const push = (id: string | null | undefined) => {
      if (!id || id.length === 0) return;
      if (/^\d+$/.test(id.trim())) return;
      unique.add(id);
    };
    for (const p of data.parts ?? []) push(p.id);
    for (const a of data.assemblies ?? []) {
      for (const p of a.parts ?? []) push(p.id);
      for (const b of a.bolts ?? []) push(b.id);
    }
    for (const row of data.boltSteelLinks ?? []) {
      push(row.boltGlobalId);
      push(row.partGlobalId);
    }

    const guids = [...unique];
    const CHUNK = 160;
    for (let i = 0; i < guids.length; i += CHUNK) {
      const slice = guids.slice(i, i + CHUNK);
      try {
        const locals = await model.getLocalIdsByGuids(slice);
        for (let j = 0; j < slice.length; j++) {
          const loc = locals[j];
          if (typeof loc !== "number" || !Number.isFinite(loc)) continue;
          const k = normalizeIfcGuidKey(slice[j]);
          if (k) this.analyzerGuidKeyToFragmentLocal.set(k, loc);
        }
      } catch {
        /* chunk failed — continue */
      }
    }

    const failed: string[] = [];
    for (const g of guids) {
      const k = normalizeIfcGuidKey(g);
      if (k && !this.analyzerGuidKeyToFragmentLocal.has(k)) failed.push(g);
    }
    for (const g of failed) {
      const nk = normalizeIfcGuidKey(g);
      if (!nk || this.analyzerGuidKeyToFragmentLocal.has(nk)) continue;
      for (const v of expandIfcGuidLookupVariants(g)) {
        try {
          const [loc] = await model.getLocalIdsByGuids([v]);
          if (typeof loc === "number" && Number.isFinite(loc)) {
            this.analyzerGuidKeyToFragmentLocal.set(nk, loc);
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }
  }

  getIsolationVisualMode(): IsolationMode {
    return this.isolationVisualMode;
  }

  /**
   * GUID keys (normalized) for bolts last passed to ייצור isolation — use with {@link applyIsolation}
   * {@link ApplyIsolationOptions.boltGuidIsolationAllowlist} / `spatialBoltIsolationAllowlist`.
   */
  getProductionBoltGuidAllowlistSnapshot(): ReadonlySet<string> | null {
    return this.productionBoltGuidAllowlistSnapshot;
  }

  /**
   * Removes synthetic ייצור hole cylinders (own geometry — must dispose).
   * Safe to call multiple times.
   */
  clearProductionHoleOverlays(): void {
    this.disposeProductionHoleOverlays();
  }

  private disposeProductionHoleOverlayGeometryOnly(): void {
    const g = this.productionHoleOverlayGroup;
    this.productionHoleOverlayGroup = null;
    if (!g) return;
    g.removeFromParent();
    const materials = new Set<THREE.Material>();
    g.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        const m = obj.material;
        if (Array.isArray(m)) for (const x of m) materials.add(x);
        else if (m) materials.add(m);
      }
    });
    for (const m of materials) m.dispose();
  }

  private disposeProductionHoleOverlays(): void {
    this.productionBoltGuidAllowlistSnapshot = null;
    this.disposeProductionHoleOverlayGeometryOnly();
  }

  private static analyzerSteelEntitiesForProductionMap(
    input: ProductionHoleOverlayInput,
  ): { id: string; expressId: number | null }[] {
    const refs = input.visibleSteelRefs;
    if (refs && refs.length > 0) return [...refs];
    return input.visibleSteelPartIds.map((id) => ({ id, expressId: null }));
  }

  private static productionSteelPartMatchesVisible(
    partGlobalId: string,
    visibleSteelPartIds: readonly string[],
  ): boolean {
    const raw = partGlobalId.trim();
    const pNorm = normalizeIfcGuidKey(partGlobalId);
    for (const v of visibleSteelPartIds) {
      const vNorm = normalizeIfcGuidKey(v);
      if (pNorm && vNorm && pNorm === vNorm) return true;
      if (raw === v.trim()) return true;
    }
    return false;
  }

  /**
   * Builds {@link productionBoltGuidAllowlistSnapshot} + steel hull context for ייצור overlays / isolation.
   * Call before {@link applyIsolation} when disc visibility must match the same GUID pool.
   */
  private async buildProductionBoltAllowlistPayload(
    input: ProductionHoleOverlayInput,
    fragModel: FragmentsModel,
    fragments: OBC.FragmentsManager,
  ): Promise<{
    boltKeyToRawGuid: Map<string, string>;
    boltByKey: Map<string, Pick<AnalyzerBoltRow, "id" | "expressId" | "boltHoleDiameterMm">>;
    steelRefBoxWorld: THREE.Box3 | null;
    /**
     * Per‑member world AABBs (one per visible steel local) — use closest distance to **any** of these
     * boxes, not the union. Critical for column assemblies where a wider base plate inflates the union
     * AABB, leaving column‑flange bolt samples 100+ mm "inside" the union and being rejected.
     */
    steelPerPartBoxesWorld: THREE.Box3[];
  }> {
    const boltKeyToRawGuid = new Map<string, string>();
    for (const link of input.boltSteelLinks ?? []) {
      if (!ViewerEngine.productionSteelPartMatchesVisible(link.partGlobalId, input.visibleSteelPartIds)) {
        continue;
      }
      const bk = normalizeIfcGuidKey(link.boltGlobalId) ?? link.boltGlobalId.trim();
      if (!bk) continue;
      if (!boltKeyToRawGuid.has(bk)) boltKeyToRawGuid.set(bk, link.boltGlobalId.trim());
    }
    for (const b of input.overlayBoltRows ?? []) {
      const bk = normalizeIfcGuidKey(b.id) ?? b.id.trim();
      if (!bk) continue;
      if (!boltKeyToRawGuid.has(bk)) boltKeyToRawGuid.set(bk, b.id.trim());
    }
    const boltByKey = new Map<string, Pick<AnalyzerBoltRow, "id" | "expressId" | "boltHoleDiameterMm">>();
    for (const b of input.bolts) {
      const k = normalizeIfcGuidKey(b.id) ?? b.id.trim();
      if (k) boltByKey.set(k, b);
    }

    let steelRefBoxWorld: THREE.Box3 | null = null;
    const steelPerPartBoxesWorld: THREE.Box3[] = [];
    try {
      const steelMap = await this.modelIdMapForAnalyzerEntities(
        ViewerEngine.analyzerSteelEntitiesForProductionMap(input),
      );
      const allIdSet = new Set(await this.allFragmentLocalIds(fragModel));
      const steelLocalsSet = new Set<number>([...(steelMap[this.modelId!] ?? [])]);
      for (const lid of input.isolationSteelLocalIds ?? []) {
        if (typeof lid === "number" && Number.isFinite(lid) && allIdSet.has(lid)) {
          steelLocalsSet.add(lid);
        }
      }
      const steelBox = new THREE.Box3();
      if (steelLocalsSet.size > 0) {
        const steelLocalsArr = [...steelLocalsSet];
        const PER_PART_CHUNK = 64;
        for (let off = 0; off < steelLocalsArr.length; off += PER_PART_CHUNK) {
          const slice = steelLocalsArr.slice(off, off + PER_PART_CHUNK);
          for (const lid of slice) {
            try {
              const arr = await fragments.getBBoxes({ [this.modelId!]: new Set([lid]) });
              for (const b of arr) {
                if (b instanceof THREE.Box3 && !b.isEmpty()) {
                  steelPerPartBoxesWorld.push(b.clone());
                  steelBox.union(b);
                }
              }
            } catch {
              /* ignore single-id failure */
            }
          }
        }
        if (!steelBox.isEmpty()) {
          steelRefBoxWorld = steelBox.clone();
        }
      }
      if (steelLocalsSet.size > 0 && steelRefBoxWorld && !steelRefBoxWorld.isEmpty()) {
        /**
         * Two‑track expansion: (a) IFC `ConnectedTo` graph reach is the **trusted** source — only its
         * hits can promote a bolt into the production allowlist directly; (b) the spatial sweep is
         * suspect and only kept when it agrees with a per‑member proximity check.
         *
         * Tall columns previously laundered neighbour bolts into the allowlist via a single union
         * hull padded by 120 mm — the union extended for the column's full height, so beam‑side bolts
         * physically next to the flange but >150 mm from any *member* still passed the test.
         */
        const ifcGraphHits = new Set<number>(steelLocalsSet);
        await this.mergeBoltHoleConnectionLocals(fragModel, ifcGraphHits, allIdSet, undefined);
        await this.mergeBoltHoleConnectionLocals(fragModel, ifcGraphHits, allIdSet, undefined);
        await this.mergeBoltHoleConnectionLocals(fragModel, ifcGraphHits, allIdSet, undefined);

        const expanded = new Set<number>(ifcGraphHits);
        await this.mergeFastenersNearIsolationSeeds(
          fragModel,
          expanded,
          [...steelLocalsSet],
          allIdSet,
          undefined,
        );

        /**
         * Per‑member padded boxes — supersedes the union hull check. Tight constant pad: a real
         * connection bolt sits at most a couple of cm off the member's actual face (head height
         * + flange thickness slop), so 60 mm covers worst case without inviting neighbours.
         */
        const PER_PART_BOLT_NEAR_PAD_M = 0.06;
        const partBoxesPadded =
          steelPerPartBoxesWorld.length > 0
            ? steelPerPartBoxesWorld.map((b) =>
                b.clone().expandByScalar(PER_PART_BOLT_NEAR_PAD_M),
              )
            : [steelRefBoxWorld.clone().expandByScalar(PER_PART_BOLT_NEAR_PAD_M)];
        const intersectsAnyPart = (bb: THREE.Box3): boolean => {
          for (const padded of partBoxesPadded) {
            if (padded.intersectsBox(bb)) return true;
          }
          return false;
        };

        const supplemental = [...expanded].filter((id) => !steelLocalsSet.has(id));
        const BCHUNK = 220;
        for (let off = 0; off < supplemental.length; off += BCHUNK) {
          const slice = supplemental.slice(off, off + BCHUNK);
          let boxes: THREE.Box3[];
          try {
            boxes = await fragments.getBBoxes({ [this.modelId!]: new Set(slice) });
          } catch {
            continue;
          }
          const nearSteel: number[] = [];
          for (let j = 0; j < slice.length; j++) {
            const bb = boxes[j];
            const lid = slice[j];
            if (!(bb instanceof THREE.Box3) || bb.isEmpty()) continue;
            /**
             * Per‑member proximity gate replaces the union‑hull test. Both spatial and IFC‑graph
             * candidates must touch a specific member's padded box; graph chains can drag in
             * plates/bolts from adjacent assemblies via shared connection nodes otherwise.
             */
            if (!intersectsAnyPart(bb)) continue;
            nearSteel.push(lid);
          }
          if (nearSteel.length === 0) continue;
          try {
            const rows = await fragModel.getItems(nearSteel);
            for (const lid of nearSteel) {
              const raw = rows.get(lid);
              if (!this.isBoltHoleConnectionCompanionCategory(raw?.category)) continue;
              const c = (raw?.category ?? "").toUpperCase();
              if (
                c.includes("OPENINGELEMENT") ||
                c.includes("OPENINGSTANDARD") ||
                c.includes("FEATUREELEMENTSUBTRACTION") ||
                c.includes("VOIDINGFEATURE")
              ) {
                continue;
              }
              const guid = typeof raw?.guid === "string" ? raw.guid.trim() : "";
              if (!guid) continue;
              const bk = normalizeIfcGuidKey(guid) ?? guid;
              if (!bk) continue;
              if (!boltKeyToRawGuid.has(bk) && !this.isIfcMechanicalStyleFastenerCategory(raw?.category)) {
                continue;
              }
              boltKeyToRawGuid.set(bk, guid);
              this.analyzerGuidKeyToFragmentLocal.set(bk, lid);
            }
          } catch {
            /* ignore chunk */
          }
        }
      }
    } catch {
      /* steel proximity / IFC expansion optional */
    }

    this.productionBoltGuidAllowlistSnapshot = new Set(boltKeyToRawGuid.keys());
    return { boltKeyToRawGuid, boltByKey, steelRefBoxWorld, steelPerPartBoxesWorld };
  }

  /**
   * Pre-compute ייצור bolt GUID allowlist (same as red discs) before {@link applyIsolation}.
   */
  primeProductionBoltAllowlistForIsolation(input: ProductionHoleOverlayInput): Promise<void> {
    return this.enqueueIsolation(async () => {
      this.disposeProductionHoleOverlayGeometryOnly();
      if (!this.modelObject || !this.modelId || input.visibleSteelPartIds.length === 0) return;
      const fragments = this.components.get(OBC.FragmentsManager);
      if (!fragments.initialized) return;
      const fragModel = fragments.list.get(this.modelId);
      if (!fragModel) return;
      await this.buildProductionBoltAllowlistPayload(input, fragModel, fragments);
    });
  }

  /** Fragment locals still visible after the latest **בודד** isolation (for ייצור disc filtering). */
  getLastIsolatedVisibleLocals(): ReadonlySet<number> | null {
    return this.lastIsolatedVisibleLocals;
  }

  /**
   * Draws dark translucent cylinders along each linked fastener’s world AABB long axis, sized from
   * `boltHoleDiameterMm` (fallback: inferred from bolt mesh short cross‑section). Runs on the
   * isolation queue so it stays ordered with `applyIsolation` / `clearIsolationVisuals`.
   */
  showProductionHoleOverlays(input: ProductionHoleOverlayInput): Promise<void> {
    return this.enqueueIsolation(async () => {
      this.disposeProductionHoleOverlayGeometryOnly();
      if (!this.modelObject || !this.modelId || input.visibleSteelPartIds.length === 0) return;

      const fragments = this.components.get(OBC.FragmentsManager);
      if (!fragments.initialized) return;
      const fragModel = fragments.list.get(this.modelId);
      if (!fragModel) return;

      const { boltKeyToRawGuid, boltByKey, steelRefBoxWorld, steelPerPartBoxesWorld } =
        await this.buildProductionBoltAllowlistPayload(input, fragModel, fragments);

      type BoltWork = {
        boltKey: string;
        rawGuid: string;
        row: Pick<AnalyzerBoltRow, "id" | "expressId" | "boltHoleDiameterMm"> | undefined;
        localId: number | null;
      };

      const works: BoltWork[] = [];
      for (const [boltKey, rawGuid] of boltKeyToRawGuid) {
        works.push({
          boltKey,
          rawGuid,
          row: boltByKey.get(boltKey),
          localId: this.analyzerGuidKeyToFragmentLocal.get(boltKey) ?? null,
        });
      }

      const unresolved = works.filter((w) => w.localId == null);
      if (unresolved.length > 0) {
        const CHUNK = 120;
        const sliceAll = unresolved.map((w) => w.rawGuid);
        for (let i = 0; i < sliceAll.length; i += CHUNK) {
          const slice = sliceAll.slice(i, i + CHUNK);
          try {
            const lids = await fragModel.getLocalIdsByGuids(slice);
            for (let j = 0; j < slice.length; j++) {
              const loc = lids[j];
              const raw = slice[j];
              const nk = normalizeIfcGuidKey(raw);
              if (typeof loc === "number" && Number.isFinite(loc) && nk) {
                this.analyzerGuidKeyToFragmentLocal.set(nk, loc);
              }
              for (const w of works) {
                if (w.localId != null) continue;
                if (
                  w.rawGuid === raw ||
                  normalizeIfcGuidKey(w.rawGuid) === nk ||
                  normalizeIfcGuidKey(w.rawGuid) === normalizeIfcGuidKey(raw)
                ) {
                  if (typeof loc === "number" && Number.isFinite(loc)) w.localId = loc;
                  break;
                }
              }
            }
          } catch {
            /* ignore chunk */
          }
        }
      }

      const stillUnresolved = works.filter((w) => w.localId == null);
      for (const w of stillUnresolved) {
        for (const v of expandIfcGuidLookupVariants(w.rawGuid)) {
          try {
            const [loc] = await fragModel.getLocalIdsByGuids([v]);
            if (typeof loc === "number" && Number.isFinite(loc)) {
              w.localId = loc;
              this.analyzerGuidKeyToFragmentLocal.set(w.boltKey, loc);
              break;
            }
          } catch {
            /* ignore */
          }
        }
      }

      const resolved = works.filter(
        (w): w is BoltWork & { localId: number } =>
          typeof w.localId === "number" && Number.isFinite(w.localId),
      );

      resolved.sort((a, b) => a.localId - b.localId);

      const discAllow = input.fastenerDiscLocalIdAllowlist;
      let resolvedForDiscs =
        discAllow != null && discAllow.size > 0
          ? resolved.filter((w) => discAllow.has(w.localId))
          : resolved;
      if (
        discAllow != null &&
        discAllow.size > 0 &&
        resolvedForDiscs.length === 0 &&
        resolved.length > 0
      ) {
        /** Allowlist can disagree with overlay `localId` spellings — prefer showing discs to a blank view. */
        resolvedForDiscs = resolved;
      }

      const tmpPosition = new THREE.Vector3();
      const tmpMatrix = new THREE.Matrix4();
      const componentBoxesFromMeshData = (mesh: MeshData): THREE.Box3[] => {
        if (!mesh.positions || mesh.positions.length < 9) return [];
        const positions = mesh.positions;
        const vertexCount = Math.floor(positions.length / 3);
        const parent = new Int32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) parent[i] = i;
        const find = (i: number): number => {
          let root = i;
          while (parent[root] !== root) root = parent[root];
          while (parent[i] !== i) {
            const next = parent[i];
            parent[i] = root;
            i = next;
          }
          return root;
        };
        const union = (a: number, b: number) => {
          const ra = find(a);
          const rb = find(b);
          if (ra !== rb) parent[rb] = ra;
        };

        const connectTriangle = (a: number, b: number, c: number) => {
          if (a < vertexCount && b < vertexCount && c < vertexCount) {
            union(a, b);
            union(b, c);
          }
        };

        if (mesh.indices && mesh.indices.length >= 3) {
          for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
            connectTriangle(mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]);
          }
        } else {
          for (let i = 0; i + 2 < vertexCount; i += 3) {
            connectTriangle(i, i + 1, i + 2);
          }
        }

        /** Non-indexed geometry often duplicates vertices per face; reconnect by shared position. */
        const firstVertexByPosition = new Map<string, number>();
        for (let i = 0; i < vertexCount; i++) {
          const key = `${positions[i * 3].toFixed(5)},${positions[i * 3 + 1].toFixed(5)},${positions[
            i * 3 + 2
          ].toFixed(5)}`;
          const prev = firstVertexByPosition.get(key);
          if (prev == null) {
            firstVertexByPosition.set(key, i);
          } else {
            union(prev, i);
          }
        }

        const matrix =
          mesh.transform instanceof THREE.Matrix4
            ? mesh.transform
            : Array.isArray(mesh.transform)
              ? tmpMatrix.fromArray(mesh.transform)
              : ArrayBuffer.isView(mesh.transform)
                ? tmpMatrix.fromArray(Array.from(mesh.transform as ArrayLike<number>))
                : null;
        const boxes = new Map<number, THREE.Box3>();
        for (let i = 0; i < vertexCount; i++) {
          const root = find(i);
          let box = boxes.get(root);
          if (!box) {
            box = new THREE.Box3();
            boxes.set(root, box);
          }
          tmpPosition.fromArray(positions, i * 3);
          if (matrix) tmpPosition.applyMatrix4(matrix);
          box.expandByPoint(tmpPosition);
        }
        return [...boxes.values()].filter((box) => !box.isEmpty());
      };

      const fetchFallbackBoxForLocal = async (localId: number): Promise<THREE.Box3 | null> => {
        try {
          const arr = await fragments.getBBoxes({ [this.modelId!]: new Set([localId]) });
          const b = arr[0];
          return b instanceof THREE.Box3 && !b.isEmpty() ? b : null;
        } catch {
          return null;
        }
      };

      const group = new THREE.Group();
      group.name = "production-hole-overlays";

      const zNormal = new THREE.Vector3(0, 0, 1);
      const axisDir = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      /**
       * De-dupe nearly identical discs **per bolt** only. A joint uses one physical pose; rounding
       * made secondary fasteners drop their discs when the primary already placed the same key.
       */
      const markerKeys = new Set<string>();
      const tmpDiscWorld = new THREE.Vector3();
      const markerMaterial = new THREE.MeshBasicMaterial({
        /** Solid hole reference — filled disc, not a ring mesh. */
        color: 0xff1010,
        transparent: false,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });

      const hasAnySteelHull =
        steelPerPartBoxesWorld.length > 0 ||
        (steelRefBoxWorld != null && !steelRefBoxWorld.isEmpty());

      /**
       * Disc must land **on or inside** a visible per‑member box (per‑member, not the union).
       * No snapping / projection: a Tekla "hole only" fastener whose sample sits between the
       * displayed plate and a hidden plate underneath has the disc fall in the gap — refusing
       * to draw is intentional, since projecting it onto the visible face would re-introduce
       * the very hole we wanted to drop.
       */
      const DISC_ON_SURFACE_TOL_M = 0.005;
      const discPointInVisiblePart = (worldPoint: THREE.Vector3): boolean => {
        if (!hasAnySteelHull) return true;
        const tmpClamp = new THREE.Vector3();
        if (steelPerPartBoxesWorld.length > 0) {
          for (const box of steelPerPartBoxesWorld) {
            if (!box || box.isEmpty()) continue;
            if (box.containsPoint(worldPoint)) return true;
            box.clampPoint(worldPoint, tmpClamp);
            if (tmpClamp.distanceTo(worldPoint) <= DISC_ON_SURFACE_TOL_M) return true;
          }
          return false;
        }
        if (steelRefBoxWorld && !steelRefBoxWorld.isEmpty()) {
          if (steelRefBoxWorld.containsPoint(worldPoint)) return true;
          steelRefBoxWorld.clampPoint(worldPoint, tmpClamp);
          if (tmpClamp.distanceTo(worldPoint) <= DISC_ON_SURFACE_TOL_M) return true;
          return false;
        }
        return true;
      };

      /**
       * `radius` = hole radius in model metres (typically {@link diameterM} / 2). Returns
       * `true` if a new disc mesh was added (i.e. position passed the on/inside test and the
       * pose was not already drawn). Callers use the return value to count actual placements,
       * so a bolt whose every disc sample falls outside any visible per-member box can be
       * hidden from isolation together with its disc.
       */
      const addMarkerDisc = (
        position: THREE.Vector3,
        normal: THREE.Vector3,
        radius: number,
        dedupeId: string,
      ): boolean => {
        if (hasAnySteelHull) {
          tmpDiscWorld.copy(position).applyMatrix4(this.modelObject!.matrixWorld);
          if (!discPointInVisiblePart(tmpDiscWorld)) return false;
        }
        const holeR = Math.max(radius, 0.003);
        const key = `${dedupeId}|${position.x.toFixed(4)},${position.y.toFixed(4)},${position.z.toFixed(
          4,
        )}|${normal.x.toFixed(2)},${normal.y.toFixed(2)},${normal.z.toFixed(2)}|${holeR.toFixed(4)}`;
        if (markerKeys.has(key)) return false;
        markerKeys.add(key);
        const geom = new THREE.CircleGeometry(holeR, 64);
        const mesh = new THREE.Mesh(geom, markerMaterial);
        mesh.name = "production-bolt-hole-disc";
        mesh.position.copy(position);
        mesh.quaternion.copy(quat.setFromUnitVectors(zNormal, normal));
        mesh.renderOrder = 20;
        group.add(mesh);
        return true;
      };

      /** All scene meshes carrying a fragment `tileId` (ThatOpen may attach more than one per tile in edge cases). */
      const tileMeshesById = new Map<number, THREE.Mesh[]>();
      this.modelObject.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const tileId = (mesh.userData as Record<string, unknown>).tileId;
        if (typeof tileId !== "number") return;
        const list = tileMeshesById.get(tileId) ?? [];
        if (!list.includes(mesh)) list.push(mesh);
        tileMeshesById.set(tileId, list);
      });
      this.modelObject.updateWorldMatrix(true, true);
      const modelWorldInverse = new THREE.Matrix4().copy(this.modelObject.matrixWorld).invert();
      const vertex = new THREE.Vector3();
      const worldVertexFromAttribute = (
        attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
        vertexIndex: number,
        matrixWorld: THREE.Matrix4,
      ): THREE.Vector3 | null => {
        try {
          if (vertexIndex < 0 || vertexIndex >= attribute.count) return null;
          vertex.fromBufferAttribute(attribute, vertexIndex);
          if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y) || !Number.isFinite(vertex.z)) {
            return null;
          }
          vertex.applyMatrix4(matrixWorld).applyMatrix4(modelWorldInverse);
          return vertex.clone();
        } catch {
          /** Some live tile chunks can point at transient/virtual geometry buffers; skip them. */
          return null;
        }
      };
      const componentBoxesFromLiveTileRange = (
        pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
        indexArray: ArrayLike<number> | null,
        start: number,
        count: number,
        matrixWorld: THREE.Matrix4,
      ): THREE.Box3[] => {
        const end = start + count;
        const nodeByVertexIndex = new Map<number, number>();
        const points: THREE.Vector3[] = [];
        const parent: number[] = [];
        const find = (i: number): number => {
          let root = i;
          while (parent[root] !== root) root = parent[root];
          while (parent[i] !== i) {
            const next = parent[i];
            parent[i] = root;
            i = next;
          }
          return root;
        };
        const union = (a: number, b: number) => {
          const ra = find(a);
          const rb = find(b);
          if (ra !== rb) parent[rb] = ra;
        };
        const getNode = (vertexIndex: number): number | null => {
          if (vertexIndex < 0 || vertexIndex >= pos.count) return null;
          const existing = nodeByVertexIndex.get(vertexIndex);
          if (existing != null) return existing;
          const p = worldVertexFromAttribute(pos, vertexIndex, matrixWorld);
          if (!p) return null;
          const node = points.length;
          points.push(p);
          parent.push(node);
          nodeByVertexIndex.set(vertexIndex, node);
          return node;
        };
        const connectTriangle = (a: number, b: number, c: number) => {
          const na = getNode(a);
          const nb = getNode(b);
          const nc = getNode(c);
          if (na == null || nb == null || nc == null) return;
          union(na, nb);
          union(nb, nc);
        };

        if (indexArray) {
          const safeEnd = Math.min(end, indexArray.length);
          for (let n = start; n + 2 < safeEnd; n += 3) {
            connectTriangle(indexArray[n], indexArray[n + 1], indexArray[n + 2]);
          }
        } else {
          const safeEnd = Math.min(end, pos.count);
          for (let n = start; n + 2 < safeEnd; n += 3) {
            connectTriangle(n, n + 1, n + 2);
          }
        }

        /** Reconnect duplicated, non-indexed face vertices by identical transformed position. */
        const byPosition = new Map<string, number>();
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const key = `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`;
          const prev = byPosition.get(key);
          if (prev == null) byPosition.set(key, i);
          else union(prev, i);
        }

        const boxes = new Map<number, THREE.Box3>();
        for (let i = 0; i < points.length; i++) {
          const root = find(i);
          let box = boxes.get(root);
          if (!box) {
            box = new THREE.Box3();
            boxes.set(root, box);
          }
          box.expandByPoint(points[i]);
        }
        return [...boxes.values()].filter((box) => !box.isEmpty());
      };

      const instanceLocal = new THREE.Matrix4();
      const effectiveWorldMatrix = new THREE.Matrix4();
      const forEachEffectiveWorldMatrix = (mesh: THREE.Mesh, fn: (world: THREE.Matrix4) => void) => {
        mesh.updateWorldMatrix(true, false);
        if ((mesh as THREE.Mesh & THREE.InstancedMesh).isInstancedMesh) {
          const im = mesh as THREE.InstancedMesh;
          for (let i = 0; i < im.count; i++) {
            im.getMatrixAt(i, instanceLocal);
            effectiveWorldMatrix.multiplyMatrices(mesh.matrixWorld, instanceLocal);
            fn(effectiveWorldMatrix);
          }
          return;
        }
        fn(mesh.matrixWorld);
      };

      const chunkBoxesFromLiveTiles = async (localId: number): Promise<THREE.Box3[]> => {
        const out: THREE.Box3[] = [];
        let chunks: { tileId: number; position: Uint32Array; size: Uint32Array }[];
        try {
          chunks = await fragModel.getItemDrawChunks([localId]);
        } catch {
          return out;
        }
        for (const chunk of chunks) {
          const meshes = tileMeshesById.get(chunk.tileId) ?? [];
          for (const mesh of meshes) {
            if (!mesh.geometry) continue;
            const pos = mesh.geometry.getAttribute("position");
            if (!pos) continue;
            const index = mesh.geometry.index;
            for (let i = 0; i < chunk.position.length; i++) {
              const start = chunk.position[i];
              const count = chunk.size[i];
              if (!Number.isFinite(start) || !Number.isFinite(count) || count === 0) continue;
              const indexArray = index?.array;
              if (index && indexArray) {
                if (start >= indexArray.length) continue;
                forEachEffectiveWorldMatrix(mesh, (world) => {
                  out.push(...componentBoxesFromLiveTileRange(pos, indexArray, start, count, world));
                });
              } else {
                if (start >= pos.count) continue;
                forEachEffectiveWorldMatrix(mesh, (world) => {
                  out.push(...componentBoxesFromLiveTileRange(pos, null, start, count, world));
                });
              }
            }
          }
        }
        return out;
      };

      const matrix4FromIfcAxisPlacement = (t: {
        position: number[];
        xDirection: number[];
        yDirection: number[];
      }): THREE.Matrix4 | null => {
        if (
          !t?.position ||
          t.position.length < 3 ||
          !t.xDirection ||
          t.xDirection.length < 3 ||
          !t.yDirection ||
          t.yDirection.length < 3
        ) {
          return null;
        }
        const x = new THREE.Vector3(t.xDirection[0], t.xDirection[1], t.xDirection[2]);
        const y0 = new THREE.Vector3(t.yDirection[0], t.yDirection[1], t.yDirection[2]);
        if (x.lengthSq() < 1e-18 || y0.lengthSq() < 1e-18) return null;
        x.normalize();
        const z = new THREE.Vector3().crossVectors(x, y0);
        if (z.lengthSq() < 1e-18) return null;
        z.normalize();
        const y = new THREE.Vector3().crossVectors(z, x).normalize();
        const m = new THREE.Matrix4();
        m.makeBasis(x, y, z);
        m.setPosition(t.position[0], t.position[1], t.position[2]);
        return m;
      };

      const sampleWorld = new THREE.Matrix4();
      const samplePos = new THREE.Vector3();
      const sampleAxis = new THREE.Vector3();

      const steelPickWorld = new THREE.Vector3();

      /**
       * Pre‑fetch each resolved bolt's world AABB so we can run a centroid test after disc
       * placement. A bolt whose **body extends below the displayed plate** (anchor bolt going
       * into concrete, or Tekla "hide bolt, show hole only" fastener bridging the visible plate
       * and a hidden one) places its disc on the plate face but its mesh protrudes below — the
       * disc test alone keeps the bolt visible and the protruding black cylinder stays on
       * screen. Hiding bolts whose **bbox centroid** is outside every visible per‑member box
       * eliminates those cylinders while joint bolts (centroid inside the flange) survive.
       */
      const boltLocalIdToWorldBox = new Map<number, THREE.Box3>();
      if (resolvedForDiscs.length > 0) {
        const BBCHUNK = 200;
        const lids = resolvedForDiscs.map((w) => w.localId);
        for (let off = 0; off < lids.length; off += BBCHUNK) {
          const slice = lids.slice(off, off + BBCHUNK);
          try {
            const boxes = await fragments.getBBoxes({ [this.modelId!]: new Set(slice) });
            for (let j = 0; j < slice.length; j++) {
              const b = boxes[j];
              if (b instanceof THREE.Box3 && !b.isEmpty()) {
                boltLocalIdToWorldBox.set(slice[j], b.clone());
              }
            }
          } catch {
            /* fall back to per‑bolt sample test only */
          }
        }
      }
      const boltCentroidWorld = new THREE.Vector3();

      /**
       * Fragment locals of bolts whose mesh must be hidden after the disc loop runs. A bolt is
       * added either because every disc candidate failed the on/inside test (no disc drawn at
       * all) or because its body centroid sits outside every visible per‑member box (disc drawn
       * but the mesh extends past the displayed steel — the protruding cylinder).
       */
      const boltLocalIdsToHide = new Set<number>();

      for (let i = 0; i < resolvedForDiscs.length; i++) {
        const work = resolvedForDiscs[i];

        const diameterM =
          work.row?.boltHoleDiameterMm != null && Number.isFinite(work.row.boltHoleDiameterMm)
            ? Math.max(work.row.boltHoleDiameterMm, 1) / 1000
            : null;

        /**
         * Tekla / IFC bolt patterns are usually **one localId** with many fragment **samples**
         * (global × local placement per physical bolt). Mesh connectivity / draw chunks alone
         * collapse those into one bbox — use element snap data for per-instance origins.
         *
         * Exporters also emit **several samples along one bolt** (head, shank, nut meshes). Those
         * are collinear — cluster them and keep **one** ring at the hole mouth (closest to steel).
         */
        let placedForBolt = 0;
        try {
          const elements = await fragModel._getElements([work.localId]);
          const holeRadius =
            diameterM != null ? Math.max(diameterM / 2, 0.004) : 0.012;
          const sampleCandidates: ProductionSampleCandidate[] = [];
          for (const el of elements) {
            const core = el.core;
            if (!core?.samples || !core.localTransforms || !core.globalTransforms) continue;
            for (const sample of Object.values(core.samples)) {
              const gRaw = core.globalTransforms[sample.item];
              const lRaw = core.localTransforms[sample.localTransform];
              if (!gRaw || !lRaw) continue;
              const gMat = matrix4FromIfcAxisPlacement(gRaw);
              const lMat = matrix4FromIfcAxisPlacement(lRaw);
              if (!gMat || !lMat) continue;
              sampleWorld.copy(gMat).multiply(lMat);
              samplePos.setFromMatrixPosition(sampleWorld).applyMatrix4(modelWorldInverse);
              sampleAxis.setFromMatrixColumn(sampleWorld, 2);
              if (sampleAxis.lengthSq() < 1e-12) continue;
              sampleAxis.normalize().transformDirection(modelWorldInverse).normalize();
              if (
                !Number.isFinite(samplePos.x) ||
                !Number.isFinite(samplePos.y) ||
                !Number.isFinite(samplePos.z) ||
                sampleAxis.lengthSq() < 1e-12
              ) {
                continue;
              }
              sampleCandidates.push({ pos: samplePos.clone(), axis: sampleAxis.clone() });
            }
          }
          const clusters = clusterFastenerSamplesByCollinearity(
            sampleCandidates,
            BOLT_SAMPLE_CLUSTER_PERP_TOL_M,
          );
          for (let ci = 0; ci < clusters.length; ci++) {
            const cl = clusters[ci]!;
            const pick = pickHoleLikeSampleForCluster(
              cl,
              steelPerPartBoxesWorld,
              steelRefBoxWorld,
              this.modelObject,
              steelPickWorld,
            );
            if (addMarkerDisc(pick.pos, pick.axis, holeRadius, `${work.boltKey}:sample:${ci}`)) {
              placedForBolt++;
            }
          }
        } catch {
          /* geometry fallback below */
        }

        if (placedForBolt > 0) {
          continue;
        }

        let candidateBoxes: THREE.Box3[] = await chunkBoxesFromLiveTiles(work.localId);
        try {
          if (candidateBoxes.length === 0) {
            const itemGeometry = await fragModel.getItemsGeometry([work.localId], FRAGMENTS_LOD_GEOMETRY);
            const chunks = itemGeometry[0] ?? [];
            for (const chunk of chunks) candidateBoxes.push(...componentBoxesFromMeshData(chunk));
          }
        } catch {
          candidateBoxes = [];
        }
        if (candidateBoxes.length === 0) {
          const fallback = await fetchFallbackBoxForLocal(work.localId);
          if (fallback) candidateBoxes = [fallback];
        }

        type ProductionBoltComponent = {
          box: THREE.Box3;
          center: THREE.Vector3;
          axis: number;
          longLen: number;
          midLen: number;
          score: number;
        };

        const strictBoltComponents = (boxes: readonly THREE.Box3[]): ProductionBoltComponent[] => {
          const out: ProductionBoltComponent[] = [];
          for (const box of boxes) {
            if (!(box instanceof THREE.Box3) || box.isEmpty()) continue;

            box.getSize(size);
            box.getCenter(center);

            const dimensions = [size.x, size.y, size.z].sort((a, b) => a - b);
            const shortLen = dimensions[0];
            const midLen = dimensions[1];
            const maxLen = dimensions[2];
            if (maxLen < 1e-6 || shortLen < 1e-6 || midLen < 1e-6) continue;

            let longAxis = 0;
            let longLen = size.x;
            if (size.y > longLen) {
              longLen = size.y;
              longAxis = 1;
            }
            if (size.z > longLen) {
              longLen = size.z;
              longAxis = 2;
            }

            const aspect = maxLen / Math.max(midLen, 1e-6);
            const nearExpectedDiameter =
              diameterM == null ||
              (midLen >= diameterM * 0.18 && midLen <= diameterM * 2.6) ||
              (shortLen >= diameterM * 0.18 && shortLen <= diameterM * 2.6);
            if (aspect < 1.25 && !nearExpectedDiameter) continue;

            out.push({
              box: box.clone(),
              center: center.clone(),
              axis: longAxis,
              longLen,
              midLen,
              score: aspect + (nearExpectedDiameter ? 2 : 0),
            });
          }
          return out;
        };

        const relaxedBoltComponents = (boxes: readonly THREE.Box3[]): ProductionBoltComponent[] => {
          const out: ProductionBoltComponent[] = [];
          for (const box of boxes) {
            if (!(box instanceof THREE.Box3) || box.isEmpty()) continue;

            box.getSize(size);
            box.getCenter(center);

            const dimensions = [size.x, size.y, size.z].sort((a, b) => a - b);
            const shortLen = dimensions[0];
            const midLen = dimensions[1];
            const maxLen = dimensions[2];
            if (maxLen < 1e-6 || shortLen < 1e-6 || midLen < 1e-6) continue;

            let longAxis = 0;
            let longLen = size.x;
            if (size.y > longLen) {
              longLen = size.y;
              longAxis = 1;
            }
            if (size.z > longLen) {
              longLen = size.z;
              longAxis = 2;
            }

            out.push({
              box: box.clone(),
              center: center.clone(),
              axis: longAxis,
              longLen,
              midLen,
              score: 0,
            });
          }
          return out;
        };

        const unionBoltComponent = (boxes: readonly THREE.Box3[]): ProductionBoltComponent | null => {
          if (boxes.length === 0) return null;
          const u = new THREE.Box3();
          for (const b of boxes) {
            if (b instanceof THREE.Box3 && !b.isEmpty()) u.union(b);
          }
          if (u.isEmpty()) return null;
          u.getSize(size);
          u.getCenter(center);
          const dims = [size.x, size.y, size.z].sort((a, b) => a - b);
          let axis = 0;
          let longLen = size.x;
          if (size.y > longLen) {
            longLen = size.y;
            axis = 1;
          }
          if (size.z > longLen) {
            longLen = size.z;
            axis = 2;
          }
          return {
            box: u.clone(),
            center: center.clone(),
            axis,
            longLen,
            midLen: dims[1],
            score: 0,
          };
        };

        let components: ProductionBoltComponent[] = strictBoltComponents(candidateBoxes);
        if (components.length === 0 && candidateBoxes.length > 0) {
          components = relaxedBoltComponents(candidateBoxes);
        }
        if (components.length === 0) {
          const fallbackComp = unionBoltComponent(candidateBoxes);
          if (fallbackComp) components = [fallbackComp];
        }

        for (let ci = 0; ci < components.length; ci++) {
          const c = components[ci]!;
          const radius =
            diameterM != null
              ? Math.max(diameterM / 2, 0.004)
              : Math.max(c.midLen * 0.45, 0.008);
          axisDir.set(0, 0, 0).setComponent(c.axis, 1);
          if (addMarkerDisc(c.center, axisDir, radius, `${work.boltKey}:mesh:${ci}`)) {
            placedForBolt++;
          }
        }

        /**
         * Last resort for joint bolts on “secondary” members: worker element trees sometimes ship
         * empty `core.samples`, and mesh heuristics may yield no component — the fragment AABB
         * still sits on the isolated steel.
         */
        if (placedForBolt === 0) {
          const fb = await fetchFallbackBoxForLocal(work.localId);
          if (fb instanceof THREE.Box3 && !fb.isEmpty()) {
            const nearSteel = (() => {
              if (!hasAnySteelHull) return true;
              if (steelPerPartBoxesWorld.length > 0) {
                for (const partBox of steelPerPartBoxesWorld) {
                  if (!partBox || partBox.isEmpty()) continue;
                  if (partBox.clone().expandByScalar(0.42).intersectsBox(fb)) return true;
                }
                return false;
              }
              return (
                steelRefBoxWorld != null &&
                !steelRefBoxWorld.isEmpty() &&
                steelRefBoxWorld.clone().expandByScalar(0.42).intersectsBox(fb)
              );
            })();
            if (nearSteel) {
              fb.getCenter(center);
              fb.getSize(size);
              let longAxis = 0;
              let longLen = size.x;
              if (size.y > longLen) {
                longLen = size.y;
                longAxis = 1;
              }
              if (size.z > longLen) {
                longLen = size.z;
                longAxis = 2;
              }
              axisDir.set(0, 0, 0).setComponent(longAxis, 1);
              const fr =
                diameterM != null
                  ? Math.max(diameterM / 2, 0.004)
                  : Math.max(Math.min(size.x, size.y, size.z) * 0.42, 0.008);
              if (addMarkerDisc(center, axisDir, fr, `${work.boltKey}:bbox-fallback`)) {
                placedForBolt++;
              }
            }
          }
        }

        if (work.localId != null) {
          /**
           * Two visibility verdicts:
           *  (a) `placedForBolt === 0` — every disc candidate failed the on/inside test, so
           *      neither the disc nor the bolt mesh should be on screen.
           *  (b) bbox centroid is outside every visible per‑member box — at least one disc
           *      passed (e.g. the bolt head landed on the plate face) but the body extends
           *      past the displayed steel. Keep the disc and drop the cylinder.
           * Verdict (a) suffices on its own when no bbox is available (worker / streaming
           * race); when a bbox is present we additionally apply (b).
           */
          let shouldHide = placedForBolt === 0;
          if (!shouldHide) {
            const bbox = boltLocalIdToWorldBox.get(work.localId);
            if (bbox && !bbox.isEmpty()) {
              bbox.getCenter(boltCentroidWorld);
              if (!discPointInVisiblePart(boltCentroidWorld)) {
                shouldHide = true;
              }
            }
          }
          if (shouldHide) boltLocalIdsToHide.add(work.localId);
        }
      }

      /**
       * Hide the IFC mesh of every bolt that either placed no disc or has its body centroid
       * outside every visible per‑member box. This keeps the displayed plate looking clean: a
       * red disc marks each hole on the plate face and there are no orphan bolt cylinders
       * floating into the hidden region below. Also drop them from
       * {@link lastIsolatedVisibleLocals} so downstream sketch edge / focus passes see the
       * corrected visible set.
       */
      if (boltLocalIdsToHide.size > 0) {
        const ids = [...boltLocalIdsToHide];
        await this.chunkInvokeIds(ids, (slice) => fragModel.setVisible(slice, false));
        if (this.lastIsolatedVisibleLocals) {
          for (const lid of ids) this.lastIsolatedVisibleLocals.delete(lid);
        }
        await this.syncFragmentsViewForced(fragments);
      }

      this.productionHoleOverlayGroup = group;
      this.modelObject.add(group);
    });
  }

  /**
   * Resolve analyzer highlight refs to ThatOpen fragment **local** ids (assemblies → all parts/bolts).
   */
  async resolveIsolationLocalIds(
    refs: Iterable<{ id: string; expressId: number | null }>,
  ): Promise<Set<number>> {
    if (!this.modelId) return new Set();
    const map = await this.modelIdMapForAnalyzerEntities(refs);
    return new Set(map[this.modelId] ?? []);
  }

  /**
   * Workers tagged as fasteners / washers for `getItemsByQuery`, minus IFC opening‑type classes —
   * used with the הבורג (hide fasteners, keep holes) toolbar toggle + view filter visibility.
   *
   * @param options.strict — when set, additionally exempts items whose attributes name them as
   *   structural connection accessories (end plates, fin plates, cleats, angles, gussets,
   *   brackets, stiffeners). Used by ייצור mode where end / fin / cap plates are part of the
   *   part the user is fabricating and must stay visible even when Tekla exports them under
   *   `IfcDiscreteAccessory` alongside actual bolts.
   */
  async resolveMechanicalFastenerLocalsToHide(
    options?: { strict?: boolean },
  ): Promise<Set<number>> {
    if (!this.modelId) return new Set();
    const fragments = this.components.get(OBC.FragmentsManager);
    const fragModel = fragments.list.get(this.modelId);
    if (!fragModel) return new Set();
    const strict = options?.strict === true;

    let queryIds: number[];
    try {
      const raw = await fragModel.getItemsByQuery({ categories: FASTENER_ITEMS_BY_QUERY_REGEX });
      queryIds = Array.isArray(raw)
        ? raw.filter((id): id is number => typeof id === "number" && Number.isFinite(id))
        : [];
    } catch {
      return new Set();
    }
    if (queryIds.length === 0) return new Set();

    const allIdSet = new Set(await this.allFragmentLocalIds(fragModel));
    const out = new Set<number>();
    /** Tekla holes as `IfcDiscreteAccessory` often ship sparse `getItems().data`; re-query via `getItemsData`. */
    const ambiguousDiscrete: number[] = [];
    const QUERY_CHUNK = 320;
    for (let off = 0; off < queryIds.length; off += QUERY_CHUNK) {
      const slice = queryIds
        .slice(off, off + QUERY_CHUNK)
        .filter((id) => allIdSet.has(id));
      if (slice.length === 0) continue;
      try {
        const rows = await fragModel.getItems(slice);
        for (const lid of slice) {
          const raw = rows.get(lid);
          if (!raw) continue;
          const cat = typeof raw.category === "string" ? raw.category : "";
          const attrs = raw.data as Record<string, { value?: unknown }> | undefined;
          if (ViewerEngine.keepsBoltHoleMachiningVisibleWithFastenersHidden(cat, attrs)) continue;
          if (strict && ViewerEngine.looksLikeStructuralConnectionAccessory(cat, attrs)) continue;

          const blob = ViewerEngine.stringifyItemAttributesForBoltHoleGuess(attrs);
          const isDiscrete = cat.toUpperCase().includes("DISCRETEACCESSORY");
          if (isDiscrete && blob.length < 28) {
            ambiguousDiscrete.push(lid);
            continue;
          }
          /**
           * Strict mode: a sparse-attribute `IfcDiscreteAccessory` could be anything — bolt, cap
           * plate, washer. The shallow heuristic can't tell, and over-hiding plates ruins the
           * ייצור view. Default to keeping it visible (the deep `getItemsData` pass below still
           * runs for unambiguous classification when keywords appear there).
           */
          if (strict && isDiscrete && blob.length < 64) {
            ambiguousDiscrete.push(lid);
            continue;
          }

          out.add(lid);
        }
      } catch {
        /* skip chunk */
      }
    }

    const ATTR_CHUNK = 80;
    for (let off = 0; off < ambiguousDiscrete.length; off += ATTR_CHUNK) {
      const slice = ambiguousDiscrete.slice(off, off + ATTR_CHUNK);
      try {
        const shallow = await fragModel.getItems(slice);
        const deepRows = await fragModel.getItemsData(slice, {
          attributesDefault: true,
          relationsDefault: { attributes: false, relations: false },
        });
        for (let j = 0; j < slice.length; j++) {
          const lid = slice[j];
          const raw = shallow.get(lid);
          const cat = typeof raw?.category === "string" ? raw.category : "";
          const deepBlob = JSON.stringify(deepRows[j] ?? {}).toUpperCase();
          if (ViewerEngine.itemDataBlobSuggestsBoltHoleManufacturing(cat, deepBlob)) continue;
          const attrsRecovered = raw?.data as Record<string, { value?: unknown }> | undefined;
          if (ViewerEngine.keepsBoltHoleMachiningVisibleWithFastenersHidden(cat, attrsRecovered)) continue;
          if (strict && ViewerEngine.looksLikeStructuralConnectionAccessory(cat, attrsRecovered)) continue;
          /** Strict: the deep blob would name BOLT/NUT/WASHER/HEX/STUD if it really were hardware. */
          if (strict && !ViewerEngine.deepBlobNamesBoltHardware(deepBlob)) continue;
          out.add(lid);
        }
      } catch {
        /* On failure keep ambiguous discrete visible (likely bore meshes with sparse summaries). */
      }
    }

    return out;
  }

  /**
   * Strict-mode deep-blob check: only hide a sparse `IfcDiscreteAccessory` item when the deep
   * `getItemsData` blob explicitly names it as bolt / nut / washer / hex / stud / thread / dowel
   * hardware. Anything ambiguous defaults to visible.
   */
  private static deepBlobNamesBoltHardware(deepBlobUpper: string): boolean {
    return (
      /\b(BOLT|NUT|WASHER|HEX|STUD|THREAD|DOWEL|SCREW|RIVET|SHEAR\s*STUD)\b/.test(deepBlobUpper) &&
      !/\b(BOLT\s*-?\s*HOLE|HOLE|BORE|DRILL|CLEARANCE|MACHINED)\b/.test(deepBlobUpper)
    );
  }

  /** Richer IFC property dump from {@link FragmentsModel.getItemsData} — bore holes often surface only here. */
  private static itemDataBlobSuggestsBoltHoleManufacturing(categoryRaw: string, jsonBlobUpper: string): boolean {
    if (ViewerEngine.boltHoleLikelyFromAttributeBlob(categoryRaw, jsonBlobUpper)) return true;
    const U = `${categoryRaw}\0${jsonBlobUpper}`.toUpperCase();
    if (/\b(BOREHOLE|BORING|TAPEREDBORING|MACHINEDHOLE|DRILLEDHOLE)\b/.test(U)) return true;
    if (/\bBOLT[-_\s.]?HOLE\b/.test(U) || /\bHOLE[-_\s.]?BOLT\b/.test(U)) return true;
    if (/\bSURFACEFEATURE\b/.test(U) && /\b(BORE|DRILL|MACHINED|CLEARANCE)\b/.test(U)) return true;
    return false;
  }

  /** Standard IFC openings / subtractive features remain visible under the בורג toggle. */
  private static isHoleLikeFragmentCategory(categoryRaw: string): boolean {
    const c = categoryRaw.toUpperCase();
    return (
      c.includes("OPENINGELEMENT") ||
      c.includes("OPENINGSTANDARD") ||
      c.includes("IFCOPENINGELEMENT") ||
      c.includes("FEATUREELEMENTSUBTRACTION") ||
      c.includes("VOIDINGFEATURE") ||
      c.includes("IFCOPENINGSTANDARDCASE")
    );
  }

  /** Tekla/other exports often classify bore geometry as SURFACEFEATURE or DISCRETEACCESSORY. */
  private static isSurfaceOrEdgeMachiningFragmentCategory(categoryRaw: string): boolean {
    const c = categoryRaw.toUpperCase();
    return (
      c.includes("SURFACEFEATURE") ||
      c.includes("IFCSURFACEFEATURE") ||
      c.includes("EDGEFEATURE") ||
      c.includes("IFCEDGEFEATURE") ||
      c.includes("PROFILEFEATURE") ||
      c.includes("IFCPATCH") ||
      c.includes("TREATMENTFEATURE")
    );
  }

  /** Text blob from IFC `Name`/QTO/Tekla custom props — detects bolt-hole meshes mis-tagged as hardware. */
  private static boltHoleLikelyFromAttributeBlob(categoryRaw: string, attrsBlob: string): boolean {
    const combined = `${categoryRaw}\0${attrsBlob}`.toUpperCase();

    const explicitHoleMachining =
      /\b(BOLT\s*-?\s*HOLE|DRILL\s*HOLE|MACHINED\s*HOLE|CLEARANCE\s*HOLE)\b/i.test(attrsBlob);
    const boreKeywords =
      /\b(BOREHOLE|BORE)\b/i.test(combined) ||
      /\bBORING\b/i.test(combined) ||
      /SURFACEFEATURE.*BORE/i.test(combined);

    /** Avoid hiding obvious bolt/nut wording */
    const looksLikeBoltComponent =
      /\b(BOLT\s*ASSEMBLY|HEX\s*BOLT|TENSION.?CONTROL|TURN.?OF.?NUT|SHEAR\s*NUT|SPLIT\s*BOLT|SHEET\s*BOLT|PURLIN\s*BOLT)\b/i.test(
        attrsBlob,
      );

    if (explicitHoleMachining || (boreKeywords && !looksLikeBoltComponent)) return true;

    /* “Hole” substring only alongside machining context */
    if (
      /\bHOLE\b/i.test(attrsBlob) &&
      (boreKeywords || /\b(DRILL|BORE|MACHINED|CLEARANCE|SURFACEFEATURE)\b/i.test(attrsBlob)) &&
      !looksLikeBoltComponent
    ) {
      return true;
    }

    return false;
  }

  private static stringifyItemAttributesForBoltHoleGuess(
    attrs: Record<string, { value?: unknown }> | undefined,
  ): string {
    if (!attrs || typeof attrs !== "object") return "";
    const parts: string[] = [];
    for (const [key, attr] of Object.entries(attrs)) {
      parts.push(key);
      const v = attr?.value;
      if (typeof v === "string") parts.push(v);
      else if (v != null && typeof v !== "object") parts.push(String(v));
    }
    return parts.join("\0");
  }

  /** True → do not hide (user wants cylindrical/cut bolt holes to stay visible). */
  private static keepsBoltHoleMachiningVisibleWithFastenersHidden(
    categoryRaw: string,
    attrs: Record<string, { value?: unknown }> | undefined,
  ): boolean {
    if (ViewerEngine.isHoleLikeFragmentCategory(categoryRaw)) return true;
    if (ViewerEngine.isSurfaceOrEdgeMachiningFragmentCategory(categoryRaw)) return true;

    const blob = ViewerEngine.stringifyItemAttributesForBoltHoleGuess(attrs);
    if (ViewerEngine.boltHoleLikelyFromAttributeBlob(categoryRaw, blob)) return true;

    /* Category-only hints without attributes (sparse exports) */
    const cOnly = categoryRaw.toUpperCase();
    if (
      cOnly.includes("RECESSFEATURE") ||
      cOnly.includes("IFCRECESSED") ||
      cOnly.includes("HOLE.") ||
      cOnly.includes(".HOLE.") ||
      cOnly.includes("-HOLE") ||
      cOnly.includes("_HOLE_")
    ) {
      return true;
    }

    return false;
  }

  /**
   * Strict-mode exemption: structural connection accessories (end plates, fin plates, shear
   * tabs, cleats, angles, gussets, brackets, stiffeners) that Tekla / Advance Steel commonly
   * export under `IfcDiscreteAccessory` alongside actual bolts. The default fastener classifier
   * sweeps the entire `IfcDiscreteAccessory` category and the global "הסתר ברגים, השאר חורים"
   * toggle accepts that trade-off — but in ייצור mode the user is fabricating one assembly and
   * connection plates **must** stay visible, so we filter them out of the hide-set here.
   *
   * Pure keyword match on the attribute blob (mark, name, profile, IFC tag) — fast and avoids
   * any deep `getItemsData` round-trip. Tightly scoped wording (`\bFIN\s*PLATE\b`, etc.) to
   * avoid catching generic bolt attribute strings that happen to mention "PLATE" in a quantity
   * description.
   */
  private static looksLikeStructuralConnectionAccessory(
    categoryRaw: string,
    attrs: Record<string, { value?: unknown }> | undefined,
  ): boolean {
    const blob = ViewerEngine.stringifyItemAttributesForBoltHoleGuess(attrs);
    const combined = `${categoryRaw}\0${blob}`.toUpperCase();
    return (
      /\b(END\s*PLATE|END\s*-?PLATE|BASE\s*PLATE|BASE\s*-?PLATE|FIN\s*PLATE|FIN\s*-?PLATE|SHEAR\s*TAB|SHEAR\s*-?TAB|GUSSET\s*PLATE|GUSSET\s*-?PLATE|CONNECTION\s*PLATE|SPLICE\s*PLATE|CAP\s*PLATE)\b/.test(
        combined,
      ) ||
      /\b(CLEAT|ANGLE\s*CLEAT|SEAT\s*ANGLE|WEB\s*ANGLE|FLANGE\s*ANGLE|GUSSET|BRACKET|STIFFENER|WEB\s*STIFFENER)\b/.test(
        combined,
      )
    );
  }

  private bboxMapFromLocalSet(selected: Set<number>): Record<string, Set<number>> {
    if (!this.modelId) return {};
    return { [this.modelId]: new Set(selected) };
  }

  /**
   * Pre-seed fragment locals for bolts explicitly tied to isolated steel in `boltSteelLinks`, so isolation
   * does not rely on bbox heuristics or weak `ConnectedTo` paths from the member alone.
   */
  private async injectIsolationBoltsFromIfcRelationRows(
    fragModel: FragmentsModel,
    locals: Set<number>,
    validLocals: ReadonlySet<number>,
    relationBoltGlobalIdsRaw: readonly string[] | undefined,
    boltGuidIsolationAllowlist: ReadonlySet<string> | undefined,
  ): Promise<void> {
    const CHUNK = 160;
    const resolvedNorm = new Set<string>();

    const tryMappedLocal = (normKey: string): boolean => {
      const loc = this.analyzerGuidKeyToFragmentLocal.get(normKey);
      if (typeof loc !== "number" || !Number.isFinite(loc) || !validLocals.has(loc)) {
        return false;
      }
      locals.add(loc);
      resolvedNorm.add(normKey);
      return true;
    };

    const recordResolved = (loc: number | null | undefined, rawGuid: string) => {
      if (typeof loc !== "number" || !Number.isFinite(loc) || !validLocals.has(loc)) return;
      locals.add(loc);
      const nk = normalizeIfcGuidKey(rawGuid);
      if (!nk || resolvedNorm.has(nk)) return;
      resolvedNorm.add(nk);
      this.analyzerGuidKeyToFragmentLocal.set(nk, loc);
    };

    const raws = [...(relationBoltGlobalIdsRaw ?? [])].filter(
      (s) => typeof s === "string" && s.trim().length > 0,
    );

    const needResolveRaw: string[] = [];
    for (const raw of raws) {
      const t = raw.trim();
      const nk = normalizeIfcGuidKey(t);
      if (nk && tryMappedLocal(nk)) continue;
      needResolveRaw.push(t);
    }

    if (boltGuidIsolationAllowlist?.size) {
      for (const k of boltGuidIsolationAllowlist) {
        if (!resolvedNorm.has(k)) tryMappedLocal(k);
      }
    }

    const uniq = [...new Set(needResolveRaw)];
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const slice = uniq.slice(i, i + CHUNK);
      try {
        const lids = await fragModel.getLocalIdsByGuids(slice);
        for (let j = 0; j < slice.length; j++) {
          recordResolved(lids[j], slice[j]);
        }
      } catch {
        /* ignore chunk */
      }
    }
  }

  /**
   * Adds opening / void fragment locals linked via IFC `HasOpenings` (`IfcRelVoidsElement`) so they
   * stay visible with isolated hosts and hide together with hosts in view filter / isolation‑hidden.
   */
  private async mergeHostedOpeningLocalIds(
    fragModel: FragmentsModel,
    locals: Set<number>,
    validLocals: ReadonlySet<number>,
  ): Promise<void> {
    if (locals.size === 0) return;
    const relConfig = {
      attributesDefault: true,
      relationsDefault: { attributes: false, relations: false },
      relations: {
        HasOpenings: { attributes: true, relations: true },
      },
    };
    const CHUNK = 96;
    const seeds = [...locals];
    for (let i = 0; i < seeds.length; i += CHUNK) {
      const slice = seeds.slice(i, i + CHUNK);
      try {
        const dataRows = await fragModel.getItemsData(slice, relConfig);
        const foundLocals = new Set<number>();
        const foundGuids = new Set<string>();
        const roots = Array.isArray(dataRows) ? dataRows : [];
        this.collectIdsAndGuidsFromItemDataRoot(roots, foundLocals, foundGuids, 8000);
        for (const lid of foundLocals) {
          if (validLocals.has(lid)) locals.add(lid);
        }
        if (foundGuids.size === 0) continue;
        const gArr = [...foundGuids];
        for (let j = 0; j < gArr.length; j += CHUNK) {
          const gSlice = gArr.slice(j, j + CHUNK);
          try {
            const lidArr = await fragModel.getLocalIdsByGuids(gSlice);
            for (let k = 0; k < lidArr.length; k++) {
              const loc = lidArr[k];
              if (typeof loc === "number" && Number.isFinite(loc) && validLocals.has(loc)) {
                locals.add(loc);
              }
            }
          } catch {
            /* ignore guid chunk */
          }
        }
      } catch {
        /* ignore local id chunk */
      }
    }
  }

  /** Washers / ancillary hardware: not usually listed in bolt–steel link extract; allow via graph from an allowed bolt. */
  private isDiscreteAccessoryCategory(categoryRaw: string | undefined): boolean {
    const c = (categoryRaw ?? "").toUpperCase();
    return c.includes("DISCRETEACCESSORY");
  }

  /** Match-only: steel neighbour parts explicitly excluded (`IfcBeam`, `IfcPlate`, … stay off isolation). */
  private isBoltHoleConnectionCompanionCategory(categoryRaw: string | undefined): boolean {
    const c = (categoryRaw ?? "").toUpperCase();
    if (!c) return false;
    if (
      c.includes("IFCBEAM") ||
      c.includes("IFCCOLUMN") ||
      c.includes("IFCPLATE") ||
      c.includes("IFCMEMBER") ||
      c.includes("IFCWALL") ||
      c.includes("IFCSLAB") ||
      c.includes("IFCCOVERING")
    ) {
      return false;
    }
    if (
      c.includes("MECHANICALFASTENER") ||
      c.includes("IFCFASTENER") ||
      (c.includes("FASTENER") && !c.includes("GRID"))
    ) {
      return true;
    }
    if (c.includes("DISCRETEACCESSORY")) return true;
    if (
      c.includes("OPENINGELEMENT") ||
      c.includes("OPENINGSTANDARD") ||
      c.includes("FEATUREELEMENTSUBTRACTION")
    ) {
      return true;
    }
    if (c.includes("VOIDINGFEATURE")) return true;
    return false;
  }

  /** True for bolt / screw‑style IFC products (excludes broad `IfcDiscreteAccessory` plates, etc.). */
  private isIfcMechanicalStyleFastenerCategory(categoryRaw: string | undefined): boolean {
    const c = (categoryRaw ?? "").toUpperCase();
    return (
      c.includes("MECHANICALFASTENER") ||
      c.includes("IFCFASTENER") ||
      (c.includes("FASTENER") && !c.includes("GRID"))
    );
  }

  /**
   * Isolation‑only: `IfcRelConnectsElements` (inverse `ConnectedTo` / `ConnectedFrom`) exposes bolts and
   * Tekla‑style hole solids adjacent to isolated parts without pulling in the whole connected neighbour.
   * Not applied in {@link applyViewVisibilityFilter} — hiding one side of a joint should not erase shared hardware.
   */
  private async mergeBoltHoleConnectionLocals(
    fragModel: FragmentsModel,
    locals: Set<number>,
    validLocals: ReadonlySet<number>,
    boltGuidIsolationAllowlist?: ReadonlySet<string>,
  ): Promise<void> {
    if (locals.size === 0) return;
    const relConfig = {
      attributesDefault: true,
      relationsDefault: { attributes: false, relations: false },
      relations: {
        ConnectedTo: { attributes: true, relations: true },
        ConnectedFrom: { attributes: true, relations: true },
      },
    };
    const CHUNK = 64;
    const ITEM_CHUNK = 200;
    const candidates = new Set<number>();
    const seeds = [...locals];
    for (let i = 0; i < seeds.length; i += CHUNK) {
      const slice = seeds.slice(i, i + CHUNK);
      try {
        const dataRows = await fragModel.getItemsData(slice, relConfig);
        const foundLocals = new Set<number>();
        const foundGuids = new Set<string>();
        const roots = Array.isArray(dataRows) ? dataRows : [];
        this.collectIdsAndGuidsFromItemDataRoot(roots, foundLocals, foundGuids, 6000);
        for (const lid of foundLocals) {
          if (validLocals.has(lid)) candidates.add(lid);
        }
        if (foundGuids.size === 0) continue;
        const gArr = [...foundGuids];
        for (let j = 0; j < gArr.length; j += CHUNK) {
          const gSlice = gArr.slice(j, j + CHUNK);
          try {
            const lidArr = await fragModel.getLocalIdsByGuids(gSlice);
            for (let k = 0; k < lidArr.length; k++) {
              const loc = lidArr[k];
              if (typeof loc === "number" && Number.isFinite(loc) && validLocals.has(loc)) {
                candidates.add(loc);
              }
            }
          } catch {
            /* ignore guid chunk */
          }
        }
      } catch {
        /* ignore fragment chunk */
      }
    }

    const toInspect = [...candidates].filter((id) => !locals.has(id));
    for (let i = 0; i < toInspect.length; i += ITEM_CHUNK) {
      const slice = toInspect.slice(i, i + ITEM_CHUNK);
      try {
        const rows = await fragModel.getItems(slice);
        const constrainBolts = boltGuidIsolationAllowlist !== undefined;
        for (const [lid, raw] of rows) {
          if (!validLocals.has(lid)) continue;
          if (!this.isBoltHoleConnectionCompanionCategory(raw.category)) continue;
          if (constrainBolts) {
            const c = (raw.category ?? "").toUpperCase();
            const isOpeningLike =
              c.includes("OPENINGELEMENT") ||
              c.includes("OPENINGSTANDARD") ||
              c.includes("FEATUREELEMENTSUBTRACTION") ||
              c.includes("VOIDINGFEATURE");
            if (!isOpeningLike) {
              const attrs = raw.data as Record<string, { value?: unknown }> | undefined;
              const isDiscrete = this.isDiscreteAccessoryCategory(raw.category);
              const structuralDiscrete =
                isDiscrete &&
                ViewerEngine.looksLikeStructuralConnectionAccessory(raw.category, attrs);
              if (!structuralDiscrete) {
                const g = normalizeIfcGuidKey(
                  typeof raw.guid === "string" ? raw.guid : null,
                );
                if (!g || !boltGuidIsolationAllowlist!.has(g)) continue;
              }
            }
          }
          locals.add(lid);
        }
      } catch {
        /* ignore inspection chunk */
      }
    }
  }

  /**
   * When IFC omits connection relations from leaf plates/beams (common with nested assemblies),
   * keep fasteners whose AABB overlaps the padded union of isolated seed parts — joint-adjacent only.
   * Isolation-only (not סינון תצוגה) to avoid phantom hardware when hiding an element.
   */
  private async mergeFastenersNearIsolationSeeds(
    fragModel: FragmentsModel,
    locals: Set<number>,
    seedSteelLocals: readonly number[],
    validLocals: ReadonlySet<number>,
    spatialBoltIsolationAllowlist?: ReadonlySet<string>,
  ): Promise<void> {
    const seeds = seedSteelLocals.filter((id) => validLocals.has(id));
    if (seeds.length === 0) return;
    /** `undefined` → run bbox merge without GUID filter (analyzer vs fragment GlobalId often diverge). */
    if (spatialBoltIsolationAllowlist !== undefined && spatialBoltIsolationAllowlist.size === 0) {
      return;
    }

    let probe: THREE.Box3;
    try {
      probe = await fragModel.getMergedBox(seeds);
    } catch {
      return;
    }
    const diagonal = probe.getSize(new THREE.Vector3()).length();
    if (!Number.isFinite(diagonal) || diagonal <= Number.EPSILON) return;

    /** Padded hull for candidate sweep; centroid prune below removes stray assembly hardware. */
    const padLow = diagonal * 0.018;
    const padHigh = diagonal * 0.16;
    const padMid = diagonal * 0.075;
    const pad = THREE.MathUtils.clamp(padMid, padLow, padHigh);
    probe.expandByScalar(pad);

    let fastenerLocals: number[] = [];
    try {
      fastenerLocals = await fragModel.getItemsByQuery({
        categories: FASTENER_ITEMS_BY_QUERY_REGEX,
      });
    } catch {
      return;
    }
    if (!Array.isArray(fastenerLocals) || fastenerLocals.length === 0) return;

    const QUERY_CHUNK = 320;
    for (let off = 0; off < fastenerLocals.length; off += QUERY_CHUNK) {
      const chunk = fastenerLocals
        .slice(off, off + QUERY_CHUNK)
        .filter((id) => validLocals.has(id) && !locals.has(id));
      if (chunk.length === 0) continue;
      let boxes: THREE.Box3[];
      try {
        boxes = await fragModel.getBoxes(chunk);
      } catch {
        continue;
      }
      const survivors: number[] = [];
      for (let i = 0; i < chunk.length; i++) {
        const b = boxes[i];
        if (b && probe.intersectsBox(b)) survivors.push(chunk[i]);
      }
      if (survivors.length === 0) continue;
      try {
        const rows = await fragModel.getItems(survivors);
        const guidConstrained =
          spatialBoltIsolationAllowlist !== undefined &&
          spatialBoltIsolationAllowlist.size > 0;
        for (const lid of survivors) {
          if (guidConstrained) {
            const raw = rows.get(lid);
            const g = normalizeIfcGuidKey(
              typeof raw?.guid === "string" ? raw.guid : null,
            );
            if (!g || !spatialBoltIsolationAllowlist!.has(g)) continue;
          }
          locals.add(lid);
        }
      } catch {
        /* chunk */
      }
    }
  }

  /**
   * Drops fasteners / washers that are geometrically detached from isolation seeds.
   * AABB–AABB overlap is unreliable (diagonal members inflate envelopes; stray bolts can share the
   * same coarse world extent). Uses **closest distance from fastener centroid → steel hull box**
   * (minimal mesh slack).
   */
  private async pruneIsolationFastenersOutsideSteelCore(
    fragModel: FragmentsModel,
    locals: Set<number>,
    seedSteelLocals: readonly number[],
    validLocals: ReadonlySet<number>,
  ): Promise<void> {
    const seeds = seedSteelLocals.filter((id) => validLocals.has(id));
    if (seeds.length === 0 || locals.size <= seeds.length) return;
    const seedSet = new Set(seeds);

    /**
     * Per-seed boxes — distance is measured to the **closest** member box, not the union. Critical
     * for column assemblies where unioning a wider base plate inflates the hull and lets unrelated
     * bolts sit "inside" the union despite being 200+ mm away from the actual column flange.
     */
    const seedBoxes: THREE.Box3[] = [];
    let unionCore: THREE.Box3 | null = null;
    try {
      const seedBBoxes = await fragModel.getBoxes(seeds);
      const merged = new THREE.Box3();
      for (const b of seedBBoxes) {
        if (b instanceof THREE.Box3 && !b.isEmpty()) {
          seedBoxes.push(b.clone());
          merged.union(b);
        }
      }
      if (!merged.isEmpty()) unionCore = merged;
    } catch {
      return;
    }
    if (seedBoxes.length === 0 || !unionCore) return;

    const unionDiagonal = unionCore.getSize(new THREE.Vector3()).length();
    if (!Number.isFinite(unionDiagonal) || unionDiagonal <= Number.EPSILON) return;

    /** Slight inflate per member for LOD / triangle hull vs IFC solid (keep small, per-box). */
    for (const sb of seedBoxes) {
      const d = sb.getSize(new THREE.Vector3()).length();
      const meshSlop = THREE.MathUtils.clamp(d * 0.012, d * 0.004, d * 0.028);
      sb.expandByScalar(meshSlop);
    }

    /**
     * Max distance bolt center may sit beyond the inflated **member** box while still belonging to
     * that member (nut stack offset from flange). Bound absolute so it stays sane on long members.
     */
    const maxCenterDetach = THREE.MathUtils.clamp(
      unionDiagonal * 0.04,
      0.004,
      0.18,
    );
    const maxDetachSq = maxCenterDetach * maxCenterDetach;

    const isSteelProductCategory = (categoryRaw: string | undefined) => {
      const c = (categoryRaw ?? "").toUpperCase();
      return (
        c.includes("IFCBEAM") ||
        c.includes("IFCCOLUMN") ||
        c.includes("IFCPLATE") ||
        c.includes("IFCMEMBER") ||
        c.includes("IFCWALL") ||
        c.includes("IFCSLAB") ||
        c.includes("IFCCOVERING")
      );
    };

    /** Fastener-ish tiles + washers; excludes openings (handled separately by mergeHosted). */
    const isIsolationHardwareCategory = (categoryRaw: string | undefined) => {
      const c = (categoryRaw ?? "").toUpperCase();
      if (isSteelProductCategory(categoryRaw)) return false;
      if (
        c.includes("MECHANICALFASTENER") ||
        c.includes("IFCFASTENER") ||
        (c.includes("FASTENER") && !c.includes("GRID"))
      )
        return true;
      return c.includes("DISCRETEACCESSORY");
    };

    /** Some tiles omit IFC class string — still try distance-based pruning for tiny geometry. */
    const isTinyAuxBox = (b: THREE.Box3) =>
      !b.isEmpty() && b.getSize(new THREE.Vector3()).length() < unionDiagonal * 0.085;

    const removable: number[] = [];
    const ITEM_CHUNK = 220;
    const boltCenter = new THREE.Vector3();
    const hullClosest = new THREE.Vector3();

    const distanceToClosestSeedBoxSq = (center: THREE.Vector3): number => {
      let best = Infinity;
      for (const sb of seedBoxes) {
        sb.clampPoint(center, hullClosest);
        const dSq = center.distanceToSquared(hullClosest);
        if (dSq < best) best = dSq;
      }
      return best;
    };

    const lids = [...locals].filter((lid) => !seedSet.has(lid) && validLocals.has(lid));
    for (let i = 0; i < lids.length; i += ITEM_CHUNK) {
      const slice = lids.slice(i, i + ITEM_CHUNK);
      let rows: Map<number, { category?: string }>;
      try {
        rows = await fragModel.getItems(slice);
      } catch {
        continue;
      }
      const cand: number[] = [];
      for (const lid of slice) {
        const raw = rows.get(lid);
        if (!raw) continue;
        const catStr = typeof raw.category === "string" ? raw.category.trim() : "";
        if (catStr !== "" && isSteelProductCategory(raw.category)) continue;
        if (catStr !== "" && !isIsolationHardwareCategory(raw.category)) continue;
        cand.push(lid);
      }

      if (cand.length === 0) continue;

      let boxes: THREE.Box3[];
      try {
        boxes = await fragModel.getBoxes(cand);
      } catch {
        continue;
      }
      for (let j = 0; j < cand.length; j++) {
        const b = boxes[j];
        const lid = cand[j];
        if (!b || b.isEmpty()) continue;

        const raw = rows.get(lid);
        const catKnown =
          !!(raw?.category != null &&
            typeof raw.category === "string" &&
            raw.category.trim().length > 0);
        if (!catKnown && !isTinyAuxBox(b)) continue;

        b.getCenter(boltCenter);
        if (distanceToClosestSeedBoxSq(boltCenter) > maxDetachSq) removable.push(lid);
      }
    }
    for (const lid of removable) locals.delete(lid);
  }

  /**
   * Drop bolt / nut / washer tiles not listed in the production GUID pool (aligned with hole discs).
   * Structural connection accessories stay via {@link looksLikeStructuralConnectionAccessory}.
   */
  private async pruneIsolationNonSteelHardwareNotAllowlisted(
    fragModel: FragmentsModel,
    locals: Set<number>,
    seedSteelLocals: readonly number[],
    validLocals: ReadonlySet<number>,
    boltGuidIsolationAllowlist: ReadonlySet<string>,
  ): Promise<void> {
    const seedSet = new Set(seedSteelLocals.filter((id) => validLocals.has(id)));
    const isSteelProductCategory = (categoryRaw: string | undefined) => {
      const c = (categoryRaw ?? "").toUpperCase();
      return (
        c.includes("IFCBEAM") ||
        c.includes("IFCCOLUMN") ||
        c.includes("IFCPLATE") ||
        c.includes("IFCMEMBER") ||
        c.includes("IFCWALL") ||
        c.includes("IFCSLAB") ||
        c.includes("IFCCOVERING")
      );
    };
    const lids = [...locals].filter((lid) => !seedSet.has(lid) && validLocals.has(lid));
    const ITEM_CHUNK = 220;
    for (let i = 0; i < lids.length; i += ITEM_CHUNK) {
      const slice = lids.slice(i, i + ITEM_CHUNK);
      let rows: Map<number, { category?: string; guid?: string; data?: unknown }>;
      try {
        rows = await fragModel.getItems(slice);
      } catch {
        continue;
      }
      for (const lid of slice) {
        const raw = rows.get(lid);
        if (!raw) continue;
        const c = (typeof raw.category === "string" ? raw.category : "").toUpperCase();
        if (
          c.includes("OPENINGELEMENT") ||
          c.includes("OPENINGSTANDARD") ||
          c.includes("FEATUREELEMENTSUBTRACTION") ||
          c.includes("VOIDINGFEATURE")
        ) {
          continue;
        }
        if (c !== "" && isSteelProductCategory(raw.category)) continue;
        const attrs = raw.data as Record<string, { value?: unknown }> | undefined;
        if (
          this.isDiscreteAccessoryCategory(raw.category) &&
          ViewerEngine.looksLikeStructuralConnectionAccessory(raw.category ?? "", attrs)
        ) {
          continue;
        }
        const isHardware =
          this.isIfcMechanicalStyleFastenerCategory(raw.category) ||
          this.isDiscreteAccessoryCategory(raw.category) ||
          (c.includes("FASTENER") && !c.includes("GRID"));
        if (!isHardware) continue;
        const g = normalizeIfcGuidKey(typeof raw.guid === "string" ? raw.guid : null);
        if (!g || !boltGuidIsolationAllowlist.has(g)) {
          locals.delete(lid);
        }
      }
    }
  }

  /**
   * מצב ייצור: drop merged tiles that are not the isolated steel seed and whose IFC GlobalId is
   * neither a visible steel part nor an allowlisted bolt — fixes neighbour fasteners that still
   * fall inside a tall column’s axis‑aligned hull and `IfcMember` tiles that evaded centroid prune.
   */
  private async pruneProductionIsolationOrphans(
    fragModel: FragmentsModel,
    locals: Set<number>,
    seedSteelLocals: readonly number[],
    validLocals: ReadonlySet<number>,
    boltGuidIsolationAllowlist: ReadonlySet<string>,
    productionVisibleSteelGuidKeys: ReadonlySet<string>,
  ): Promise<void> {
    if (productionVisibleSteelGuidKeys.size === 0 || boltGuidIsolationAllowlist.size === 0) return;
    const seedSet = new Set(seedSteelLocals.filter((id) => validLocals.has(id)));

    const isOpeningLike = (categoryRaw: string | undefined) => {
      const c = (categoryRaw ?? "").toUpperCase();
      return (
        c.includes("OPENINGELEMENT") ||
        c.includes("OPENINGSTANDARD") ||
        c.includes("FEATUREELEMENTSUBTRACTION") ||
        c.includes("VOIDINGFEATURE")
      );
    };

    const shouldDrop = (
      raw: { category?: string; guid?: string; data?: unknown } | undefined,
    ): boolean => {
      if (!raw) return false;
      if (isOpeningLike(raw.category)) return false;
      const attrs = raw.data as Record<string, { value?: unknown }> | undefined;
      if (
        this.isDiscreteAccessoryCategory(raw.category) &&
        ViewerEngine.looksLikeStructuralConnectionAccessory(raw.category ?? "", attrs)
      ) {
        return false;
      }
      const g = normalizeIfcGuidKey(typeof raw.guid === "string" ? raw.guid : null);
      if (g && boltGuidIsolationAllowlist.has(g)) return false;
      if (g && productionVisibleSteelGuidKeys.has(g)) return false;
      if (this.isIfcMechanicalStyleFastenerCategory(raw.category)) return true;
      if (this.isDiscreteAccessoryCategory(raw.category)) return true;
      const c = (raw.category ?? "").toUpperCase();
      if (c.includes("FASTENER") && !c.includes("GRID")) return true;
      return false;
    };

    let queryHits: number[] = [];
    try {
      const raw = await fragModel.getItemsByQuery({ categories: FASTENER_ITEMS_BY_QUERY_REGEX });
      if (Array.isArray(raw)) {
        queryHits = raw.filter(
          (id): id is number =>
            typeof id === "number" &&
            Number.isFinite(id) &&
            locals.has(id) &&
            !seedSet.has(id) &&
            validLocals.has(id),
        );
      }
    } catch {
      /* ignore */
    }

    const ITEM_CHUNK = 220;
    for (let i = 0; i < queryHits.length; i += ITEM_CHUNK) {
      const slice = queryHits.slice(i, i + ITEM_CHUNK);
      try {
        const rows = await fragModel.getItems(slice);
        for (const lid of slice) {
          const raw = rows.get(lid);
          if (shouldDrop(raw)) locals.delete(lid);
        }
      } catch {
        /* ignore */
      }
    }

    const lids = [...locals].filter((lid) => !seedSet.has(lid) && validLocals.has(lid));
    for (let i = 0; i < lids.length; i += ITEM_CHUNK) {
      const slice = lids.slice(i, i + ITEM_CHUNK);
      try {
        const rows = await fragModel.getItems(slice);
        for (const lid of slice) {
          if (!locals.has(lid)) continue;
          const raw = rows.get(lid);
          if (shouldDrop(raw)) locals.delete(lid);
        }
      } catch {
        /* ignore */
      }
    }

    /** Tekla often tags bolt clusters as `IfcMember`; drop ones whose GUID is not our steel or bolts. */
    let coreDiag = 0;
    let coreHull: THREE.Box3 | null = null;
    let maxDetachSq = 0;
    try {
      const seeds = [...seedSteelLocals].filter((id) => validLocals.has(id));
      if (seeds.length > 0) {
        const core = await fragModel.getMergedBox(seeds);
        const d = core.getSize(new THREE.Vector3()).length();
        if (Number.isFinite(d) && d > Number.EPSILON) {
          coreDiag = d;
          const meshSlop = THREE.MathUtils.clamp(d * 0.012, d * 0.004, d * 0.028);
          coreHull = core.clone().expandByScalar(meshSlop);
          const maxCenterDetach = THREE.MathUtils.clamp(
            d * 0.055,
            0.004,
            Math.min(0.22, d * 0.12),
          );
          maxDetachSq = maxCenterDetach * maxCenterDetach;
        }
      }
    } catch {
      /* ignore */
    }
    const tinyMisclassifiedMemberCap = THREE.MathUtils.clamp(
      coreDiag > 0 ? coreDiag * 0.042 : 0.22,
      0.1,
      0.32,
    );

    const memberSteelOrphans: number[] = [];
    const lids2 = [...locals].filter((lid) => !seedSet.has(lid) && validLocals.has(lid));
    for (let i = 0; i < lids2.length; i += ITEM_CHUNK) {
      const slice = lids2.slice(i, i + ITEM_CHUNK);
      try {
        const rows = await fragModel.getItems(slice);
        for (const lid of slice) {
          if (!locals.has(lid)) continue;
          const raw = rows.get(lid);
          if (!raw) continue;
          if (isOpeningLike(raw.category)) continue;
          const catU = (raw.category ?? "").toUpperCase();
          if (!catU.includes("MEMBER")) continue;
          const g = normalizeIfcGuidKey(typeof raw.guid === "string" ? raw.guid : null);
          if (!g) continue;
          if (boltGuidIsolationAllowlist.has(g) || productionVisibleSteelGuidKeys.has(g)) continue;
          memberSteelOrphans.push(lid);
        }
      } catch {
        /* ignore */
      }
    }

    const boltCenter = new THREE.Vector3();
    const hullClosest = new THREE.Vector3();
    for (let i = 0; i < memberSteelOrphans.length; i += ITEM_CHUNK) {
      const slice = memberSteelOrphans.slice(i, i + ITEM_CHUNK);
      try {
        const boxes = await fragModel.getBoxes(slice);
        for (let j = 0; j < slice.length; j++) {
          const b = boxes[j];
          const lid = slice[j];
          if (!b || b.isEmpty()) continue;
          const diag = b.getSize(new THREE.Vector3()).length();
          let drop = diag <= tinyMisclassifiedMemberCap;
          if (!drop && coreHull != null && maxDetachSq > 0) {
            b.getCenter(boltCenter);
            coreHull.clampPoint(boltCenter, hullClosest);
            drop = boltCenter.distanceToSquared(hullClosest) > maxDetachSq;
          }
          if (drop) locals.delete(lid);
        }
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * IFC `boltSteelLinks` isolation: {@link mergeBoltHoleConnectionLocals} without a GUID gate pulls
   * every fastener reachable via `ConnectedTo` (often the whole assembly).
   * See {@link LONG_SINGLE_STEEL_DIAGONAL_M} for short vs long single-stock behaviour.
   */
  private async pruneRelationIsolationHardwareAgainstAllowlist(
    fragModel: FragmentsModel,
    locals: Set<number>,
    seedSteelLocals: readonly number[],
    validLocals: ReadonlySet<number>,
    boltGuidIsolationAllowlist: ReadonlySet<string>,
  ): Promise<void> {
    const seeds = seedSteelLocals.filter((id) => validLocals.has(id));
    if (seeds.length === 0 || boltGuidIsolationAllowlist.size === 0) return;
    const seedSet = new Set(seeds);

    let core: THREE.Box3;
    try {
      core = await fragModel.getMergedBox(seeds);
    } catch {
      return;
    }
    const diagonal = core.getSize(new THREE.Vector3()).length();
    if (!Number.isFinite(diagonal) || diagonal <= Number.EPSILON) return;

    const meshSlop = THREE.MathUtils.clamp(diagonal * 0.012, diagonal * 0.004, diagonal * 0.028);
    core.expandByScalar(meshSlop);

    const maxCenterDetach = THREE.MathUtils.clamp(
      diagonal * 0.055,
      0.004,
      Math.min(0.22, diagonal * 0.12),
    );
    const maxDetachSq = maxCenterDetach * maxCenterDetach;

    /** Long slender isolates — hull distance treats “somewhere along this flange” like “here”. */
    const strictLongSingleSteel = diagonal >= LONG_SINGLE_STEEL_DIAGONAL_M;
    /** Narrow salvage for washers that rarely appear as link rows yet sit flush with steel. */
    const longSteelWasherDetach = THREE.MathUtils.clamp(
      diagonal * 0.009,
      0.008,
      0.036,
    );
    const longSteelWasherDetachSq = longSteelWasherDetach * longSteelWasherDetach;

    const isSteelProductCategory = (categoryRaw: string | undefined) => {
      const c = (categoryRaw ?? "").toUpperCase();
      return (
        c.includes("IFCBEAM") ||
        c.includes("IFCCOLUMN") ||
        c.includes("IFCPLATE") ||
        c.includes("IFCMEMBER") ||
        c.includes("IFCWALL") ||
        c.includes("IFCSLAB") ||
        c.includes("IFCCOVERING")
      );
    };

    const isIsolationHardwareCategory = (categoryRaw: string | undefined) => {
      const c = (categoryRaw ?? "").toUpperCase();
      if (isSteelProductCategory(categoryRaw)) return false;
      if (
        c.includes("MECHANICALFASTENER") ||
        c.includes("IFCFASTENER") ||
        (c.includes("FASTENER") && !c.includes("GRID"))
      )
        return true;
      return c.includes("DISCRETEACCESSORY");
    };

    const isTinyAuxBox = (b: THREE.Box3) =>
      !b.isEmpty() && b.getSize(new THREE.Vector3()).length() < diagonal * 0.085;

    const removable: number[] = [];
    const ITEM_CHUNK = 220;
    const boltCenter = new THREE.Vector3();
    const hullClosest = new THREE.Vector3();

    const lids = [...locals].filter((lid) => !seedSet.has(lid) && validLocals.has(lid));
    for (let i = 0; i < lids.length; i += ITEM_CHUNK) {
      const slice = lids.slice(i, i + ITEM_CHUNK);
      let rows: Map<number, { category?: string; guid?: string }>;
      try {
        rows = await fragModel.getItems(slice);
      } catch {
        continue;
      }
      const cand: number[] = [];
      for (const lid of slice) {
        const raw = rows.get(lid);
        if (!raw) continue;
        const catStr = typeof raw.category === "string" ? raw.category.trim() : "";
        if (catStr !== "" && isSteelProductCategory(raw.category)) continue;
        if (catStr !== "" && !isIsolationHardwareCategory(raw.category)) continue;
        cand.push(lid);
      }
      if (cand.length === 0) continue;

      let boxes: THREE.Box3[];
      try {
        boxes = await fragModel.getBoxes(cand);
      } catch {
        continue;
      }
      for (let j = 0; j < cand.length; j++) {
        const b = boxes[j];
        const lid = cand[j];
        if (!b || b.isEmpty()) continue;

        const raw = rows.get(lid);
        const catKnown =
          !!(raw?.category != null &&
            typeof raw.category === "string" &&
            raw.category.trim().length > 0);
        if (!catKnown && !isTinyAuxBox(b)) continue;

        const g = normalizeIfcGuidKey(typeof raw?.guid === "string" ? raw.guid : null);
        const allowlisted = !!(g && boltGuidIsolationAllowlist.has(g));
        if (allowlisted) continue;

        b.getCenter(boltCenter);
        core.clampPoint(boltCenter, hullClosest);
        const dSq = boltCenter.distanceToSquared(hullClosest);

        if (!strictLongSingleSteel) {
          if (dSq <= maxDetachSq) continue;
          removable.push(lid);
          continue;
        }

        const isDiscrete = this.isDiscreteAccessoryCategory(
          typeof raw?.category === "string" ? raw.category : undefined,
        );
        if (isDiscrete && dSq <= longSteelWasherDetachSq && isTinyAuxBox(b)) {
          continue;
        }
        removable.push(lid);
      }
    }
    for (const lid of removable) locals.delete(lid);
  }

  /** Full model id list from worker — avoids `getItemsByVisibility` after `resetVisible` (stale until tiles sync). */
  private async allFragmentLocalIds(fragModel: FragmentsModel): Promise<number[]> {
    const raw = await fragModel.getLocalIds();
    return Array.isArray(raw) ? (raw as number[]) : [];
  }

  private clearContextMainThreadVisuals(): void {
    disposePickedEdgeOverlay(this.pickedEdgeOverlay);
    this.pickedEdgeOverlay = null;
    disposePickedEdgeOverlay(this.viewFilterEdgeOverlay);
    this.viewFilterEdgeOverlay = null;
    this.viewFilterSuppressMainSketchEdges = false;
    setContextIsolationEdgeOpacity(
      null,
      this.modelObject,
      this.sketchEdgeMaterialPool,
    );
    for (const mesh of this.contextOverlayMeshes) {
      mesh.parent?.remove(mesh);
      const material = mesh.material;
      if (Array.isArray(material)) {
        for (const mat of material) mat.dispose();
      } else {
        material.dispose();
      }
      // Do not dispose geometry: ghost snapshot meshes share fragment geometry buffers.
    }
    this.contextOverlayMeshes.length = 0;

  }

  private clearPickedSelectionEdgeOverlay(): void {
    disposePickedEdgeOverlay(this.pickedEdgeOverlay);
    this.pickedEdgeOverlay = null;
  }

  private async rebuildPickedSelectionEdgeOverlay(
    fragModel: FragmentsModel,
    localIds: Iterable<number>,
  ): Promise<void> {
    this.clearPickedSelectionEdgeOverlay();
    if (!this.modelObject) return;
    const ids = [...new Set(localIds)].filter((n) => Number.isFinite(n));
    if (ids.length === 0) return;

    this.pickedEdgeOverlay = await buildPickedEdgeOverlay(
      fragModel,
      this.modelObject,
      ids,
      this.sketchEdgeMaterialPool,
      { faceColorOverride: SELECTION_EDGE_FACE_COLOR },
    );
    this.modelObject.add(this.pickedEdgeOverlay);
  }

  private extractFragmentDisplayColor(mesh: THREE.Mesh): THREE.Color {
    const mats = mesh.material;
    const m0 = Array.isArray(mats) ? mats[0] : mats;
    if (!m0) return new THREE.Color(0x8f98a3);
    if (isLodFragmentMaterial(m0)) {
      return (m0 as THREE.ShaderMaterial & { lodColor: THREE.Color }).lodColor.clone();
    }
    if (
      m0 instanceof THREE.MeshStandardMaterial ||
      m0 instanceof THREE.MeshLambertMaterial ||
      m0 instanceof THREE.MeshPhongMaterial
    ) {
      return m0.color.clone();
    }
    const c = (m0 as { color?: THREE.Color }).color;
    if (c instanceof THREE.Color) return c.clone();
    return new THREE.Color(0x8f98a3);
  }

  /** Semi-transparent context overlay: same IFC hue as the source tile (see visual-policy opacity). */
  private makeContextGhostMaterialForMesh(mesh: THREE.Mesh): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color: this.extractFragmentDisplayColor(mesh),
      opacity: CONTEXT_GHOST_FACE_OPACITY,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
  }

  private createContextGhostSnapshot(): number {
    if (!this.modelObject) return 0;
    let meshCount = 0;
    this.modelObject.traverse((obj) => {
      const mesh = obj as THREE.Mesh & THREE.InstancedMesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (mesh.name === CONTEXT_GHOST_SNAPSHOT_NAME) return;

      const ghostMaterial = this.makeContextGhostMaterialForMesh(mesh);

      if (mesh.isInstancedMesh) {
        const im = mesh;
        if (im.count <= 0) return;
        const ghost = new THREE.InstancedMesh(im.geometry, ghostMaterial, im.count);
        ghost.name = CONTEXT_GHOST_SNAPSHOT_NAME;
        ghost.renderOrder = -10;
        ghost.matrixAutoUpdate = im.matrixAutoUpdate;
        ghost.position.copy(im.position);
        ghost.quaternion.copy(im.quaternion);
        ghost.scale.copy(im.scale);
        ghost.matrix.copy(im.matrix);
        ghost.matrixWorld.copy(im.matrixWorld);
        ghost.frustumCulled = im.frustumCulled;
        ghost.instanceMatrix.copy(im.instanceMatrix);
        ghost.instanceMatrix.needsUpdate = true;
        im.parent?.add(ghost);
        this.contextOverlayMeshes.push(ghost);
        meshCount++;
        return;
      }

      const ghost = new THREE.Mesh(mesh.geometry, ghostMaterial);
      ghost.name = CONTEXT_GHOST_SNAPSHOT_NAME;
      ghost.renderOrder = -10;
      ghost.matrixAutoUpdate = mesh.matrixAutoUpdate;
      ghost.position.copy(mesh.position);
      ghost.quaternion.copy(mesh.quaternion);
      ghost.scale.copy(mesh.scale);
      ghost.matrix.copy(mesh.matrix);
      ghost.matrixWorld.copy(mesh.matrixWorld);
      let previousGroups: typeof mesh.geometry.groups | null = null;
      ghost.onBeforeRender = () => {
        previousGroups = mesh.geometry.groups.map((group) => ({ ...group }));
        mesh.geometry.clearGroups();
        const count =
          mesh.geometry.index?.count ??
          mesh.geometry.getAttribute("position")?.count ??
          0;
        if (count > 0) mesh.geometry.addGroup(0, count, 0);
      };
      ghost.onAfterRender = () => {
        mesh.geometry.clearGroups();
        for (const group of previousGroups ?? []) {
          mesh.geometry.addGroup(group.start, group.count, group.materialIndex);
        }
        previousGroups = null;
      };
      mesh.parent?.add(ghost);
      this.contextOverlayMeshes.push(ghost);
      meshCount++;
    });
    return meshCount;
  }

  private async chunkInvokeIds(ids: number[], invoke: (slice: number[]) => Promise<void>): Promise<void> {
    for (let i = 0; i < ids.length; i += ISOLATION_WORKER_CHUNK) {
      const slice = ids.slice(i, i + ISOLATION_WORKER_CHUNK);
      if (slice.length > 0) await invoke(slice);
    }
  }

  /**
   * `FragmentsModels.update` early-outs when called inside {@link FragmentsModels.settings.maxUpdateRate}
   * (~100ms). Isolation uses worker `tiles.restart()`; a skipped update leaves ghosts/hidden state stale
   * on repeat "הצג בהקשר" / בודד until some later interaction.
   */
  private async syncFragmentsViewForced(fragments: OBC.FragmentsManager): Promise<void> {
    const core = fragments.core;
    const prev = core.settings.maxUpdateRate;
    core.settings.maxUpdateRate = 0;
    try {
      await core.update(true);
    } finally {
      core.settings.maxUpdateRate = prev;
    }
  }

  /** Lets postMessage tile batches land before a follow-up forced update (repeat isolation). */
  private async deferSyncFragmentsView(fragments: OBC.FragmentsManager): Promise<void> {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (!this.disposed) await this.syncFragmentsViewForced(fragments);
  }

  private enqueueIsolation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.isolationChain.then(fn);
    this.isolationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async focusBboxMap(map: Record<string, Set<number>>): Promise<void> {
    if (!this.modelId) return;
    const set = map[this.modelId];
    if (!set || set.size === 0) return;
    this.clearStoredPickOrbitPivot();
    try {
      const fragments = this.components.get(OBC.FragmentsManager);
      const boxes = await fragments.getBBoxes(map);
      if (!boxes.length) return;
      const aggregate = new THREE.Box3();
      boxes.forEach((box) => aggregate.union(box));
      const center = aggregate.getCenter(new THREE.Vector3());
      const size = aggregate.getSize(new THREE.Vector3()).length();
      const offset = Math.max(size, 5);
      const ctrl = this.world.camera.controls;
      ctrl?.setOrbitPoint(center.x, center.y, center.z);
      ctrl?.setLookAt(
        center.x + offset,
        center.y + offset,
        center.z + offset,
        center.x,
        center.y,
        center.z,
        false,
      );
      /**
       * Seed the sticky orbit pivot at the focused bbox center. Otherwise the first
       * `controlstart` after `applyIsolation` / `focusAnalyzerSubset` falls through to
       * {@link applyOrbitPivotFromModelPickLikeTap} which raycasts at the last pointer NDC —
       * typically the row/button the user clicked, not the focused subset — and the orbit
       * radius ends up wherever that raycast happened to hit. Pre-seeding gives the very
       * first gesture the same "I picked this part" pivot a model click would produce.
       */
      this.pickOrbitPivotWorld.copy(center);
      this.pickOrbitPivotActive = true;
    } catch (error) {
      console.error("Focus failed:", error);
    }
  }

  private highlightMaterialParams() {
    return buildSelectionHighlightMaterial();
  }

  /**
   * Restore sketch outline materials if a legacy selection tint was applied (LineSegments swap).
   */
  private clearSelectionOutlineTint(): void {
    if (this.modelObject) {
      restoreSelectionTintOnSketchLineSegments(this.modelObject);
    }
  }

  private async applyHighlightToMap(map: Record<string, Set<number>>): Promise<void> {
    const fragments = this.components.get(OBC.FragmentsManager);
    await fragments.highlight(this.highlightMaterialParams(), map);
  }

  /**
   * Full isolation: hide all non-selected items (worker visibility). Selection keeps IFC materials
   * (no blue highlight). Openings (`HasOpenings`) plus bolt / hole solids linked via
   * `ConnectedTo` / `ConnectedFrom` are merged into the selection. Default tile sketch edges are off (avoids leaking
   * hidden geometry); picked locals get a dedicated edge overlay. Context: ghost snapshot faces + same
   * overlay on picked. Hidden (הסתר): picked items worker-invisible; remainder uses a per-element edge
   * overlay (LOD tile wires cannot hide only some instances in a batch without full-opacity leaks).
   */
  /**
   * @param localIds Fragment locals to keep emphasized. For **`context`**, this set may be **empty**
   *   to show the entire model as context ghosts until items are revealed (סינון תצוגה).
   */
  applyIsolation(
    mode: "isolated" | "context" | "hidden",
    localIds: Set<number>,
    options?: ApplyIsolationOptions,
  ): Promise<boolean> {
    return this.enqueueIsolation(() => this.applyIsolationImpl(mode, localIds, options));
  }

  private async applyIsolationImpl(
    mode: "isolated" | "context" | "hidden",
    localIds: Set<number>,
    options?: ApplyIsolationOptions,
  ): Promise<boolean> {
    if (this.disposed || !this.modelId) {
      return false;
    }
    /** Context with an empty set = full-model ghost (סינון תצוגה tab “reveal” mode). */
    if (localIds.size === 0 && mode !== "context") {
      return false;
    }
    const fragments = this.components.get(OBC.FragmentsManager);
    const fragModel = fragments.list.get(this.modelId);
    if (!fragModel) {
      return false;
    }
    const doFocus = options?.focus !== false;

    if (mode !== "isolated") {
      this.lastIsolatedVisibleLocals = null;
    }

    this.inspectionIsolationSketchReadable = false;

    this.clearContextMainThreadVisuals();
    this.clearHiddenRemainderSketchDebounceTimer();
    if (mode !== "hidden") {
      this.shutdownHiddenRemainderSketchState();
    }
    const prevIsolationVisual = this.isolationVisualMode;
    await fragments.resetHighlight();
    /**
     * `resetVisible` → worker `tiles.restart()` → `_meshConnection.clean()`. That is required when
     * leaving **בודד** (`setVisible` hides), but after **הצג הכל** it only adds an extra restart on
     * top of highlight restore and tends to break repeat **הצג בהקשר** (`setOpacity` stops
     * affecting the GL view even though invokes succeed).
     */
    const mustResetVisible =
      mode === "isolated" ||
      mode === "hidden" ||
      prevIsolationVisual === "isolated" ||
      prevIsolationVisual === "hidden";
    if (mustResetVisible) {
      await fragModel.resetVisible();
    }
    await this.syncFragmentsViewForced(fragments);

    const allIds = await this.allFragmentLocalIds(fragModel);
    const allIdSet = new Set(allIds);
    const selected = new Set<number>();
    for (const id of localIds) {
      if (allIdSet.has(id)) selected.add(id);
    }
    if (selected.size === 0) {
      if (mode === "hidden") {
        this.shutdownHiddenRemainderSketchState();
      }
      if (mode !== "context") {
        return false;
      }
    }

    let coreEdgeOverlayLocals: number[] = [];

    const boltAllow = options?.boltGuidIsolationAllowlist;
    const spatialBoltAllow = options?.spatialBoltIsolationAllowlist;
    const useIfcBoltRel = !!options?.useIfcBoltSteelRelationIsolation;
    /**
     * Strict per-fragment GUID filter breaks when exporter GUIDs diverge from the analyzer JSON;
     * relation mode relies on IFC `ConnectedTo` from the isolated steel (+ injected locals) instead.
     */
    const graphBoltGuidAllowlist = useIfcBoltRel ? undefined : boltAllow;

    if (selected.size > 0) {
      coreEdgeOverlayLocals = [...selected];
      const isolationSeedLocals = [...selected];
      await this.mergeHostedOpeningLocalIds(fragModel, selected, allIdSet);
      if (useIfcBoltRel) {
        await this.injectIsolationBoltsFromIfcRelationRows(
          fragModel,
          selected,
          allIdSet,
          options.relationBoltGlobalIdsRaw,
          boltAllow,
        );
      }
      /** Two hops: fasteners → washers / nested accessories rarely appear as one IFC step from the plate. */
      await this.mergeBoltHoleConnectionLocals(fragModel, selected, allIdSet, graphBoltGuidAllowlist);
      await this.mergeBoltHoleConnectionLocals(fragModel, selected, allIdSet, graphBoltGuidAllowlist);
      if (useIfcBoltRel) {
        /**
         * Flange bolts are sometimes absent from fragment `ConnectedTo` from steel; padded bbox catches them.
         * {@link pruneRelationIsolationHardwareAgainstAllowlist} strips assembly-wide pieces outside link+proximity.
         */
        await this.mergeFastenersNearIsolationSeeds(
          fragModel,
          selected,
          isolationSeedLocals,
          allIdSet,
          undefined,
        );
      } else {
        await this.mergeFastenersNearIsolationSeeds(
          fragModel,
          selected,
          isolationSeedLocals,
          allIdSet,
          spatialBoltAllow,
        );
      }
      await this.mergeBoltHoleConnectionLocals(fragModel, selected, allIdSet, graphBoltGuidAllowlist);
      if (useIfcBoltRel && boltAllow && boltAllow.size > 0) {
        await this.pruneRelationIsolationHardwareAgainstAllowlist(
          fragModel,
          selected,
          isolationSeedLocals,
          allIdSet,
          boltAllow,
        );
      }
      if (!useIfcBoltRel) {
        await this.pruneIsolationFastenersOutsideSteelCore(
          fragModel,
          selected,
          isolationSeedLocals,
          allIdSet,
        );
      }
      if (
        options?.enforceProductionBoltHardwareAllowlist === true &&
        boltAllow &&
        boltAllow.size > 0
      ) {
        await this.pruneIsolationNonSteelHardwareNotAllowlisted(
          fragModel,
          selected,
          isolationSeedLocals,
          allIdSet,
          boltAllow,
        );
        const steelKeys = options?.productionVisibleSteelGuidKeys;
        if (steelKeys && steelKeys.size > 0) {
          await this.pruneProductionIsolationOrphans(
            fragModel,
            selected,
            isolationSeedLocals,
            allIdSet,
            boltAllow,
            steelKeys,
          );
        }
      }

      if (mode === "hidden") {
        this.isolationHiddenExcludedLocals = new Set(selected);
      }
    }

    /**
     * ייצור: strip every fastener local from the isolated subset (and from the edge overlay)
     * after merges so the user sees holes-in-steel but not the bolt/nut/washer hardware. We do
     * this **after** merges so `mergeHostedOpeningLocalIds` has already pulled the openings
     * into `selected` — those stay in the visible set because the classifier explicitly keeps
     * opening / surface-feature / discrete-accessory bore meshes.
     *
     * Skipped for "hidden" mode (which intentionally hides the selected set, so removing items
     * from it would reveal them — opposite of the user's intent).
     */
    if (options?.hideBoltsKeepHoles === true && mode !== "hidden" && selected.size > 0) {
      /**
       * Strict mode: keep structural connection accessories (end / fin / cap plates, cleats,
       * angles, gussets, brackets, stiffeners) visible even when they ship under
       * `IfcDiscreteAccessory`. The default classifier — used by the global "הסתר ברגים, השאר
       * חורים" toolbar — sweeps the whole DiscreteAccessory category and accepts that trade-off,
       * but in ייצור we are looking at a single fabricated assembly where the plates are the
       * point of the view and must not disappear.
       */
      const fastenerLocals = await this.resolveMechanicalFastenerLocalsToHide({ strict: true });
      if (fastenerLocals.size > 0) {
        for (const id of fastenerLocals) selected.delete(id);
        if (coreEdgeOverlayLocals.length > 0) {
          coreEdgeOverlayLocals = coreEdgeOverlayLocals.filter((id) => !fastenerLocals.has(id));
        }
      }
    }

    const map = this.bboxMapFromLocalSet(selected);

    if (mode === "isolated") {
      if (options?.inspectionReadableSketch === true) {
        this.inspectionIsolationSketchReadable = true;
      }
      const toHide = allIds.filter((id) => !selected.has(id));
      await this.chunkInvokeIds(toHide, (slice) => fragModel.setVisible(slice, false));
      this.isolationVisualMode = "isolated";
      this.lastIsolatedVisibleLocals = new Set(selected);
      await this.syncFragmentsViewForced(fragments);
      if (doFocus && selected.size > 0) {
        await this.focusBboxMap(map);
        await this.syncFragmentsViewForced(fragments);
      }
      await this.deferSyncFragmentsView(fragments);
      this.syncSketchEdgeVisibilityToIsolationState();
      /**
       * `setVisible(toHide, false)` only hides faces (worker draw groups / `itemFilter`); main-view
       * sketch edges are independent line geometry that never tracks per-item visibility, so we hide
       * them globally above and draw the picked outline as a per-item overlay built from
       * `getItemsGeometry` — same source the context mode overlay uses.
       */
      const edgeOverlayLocals =
        options?.inspectionReadableSketch === true ? [...selected] : coreEdgeOverlayLocals;

      if (this.modelObject) {
        this.pickedEdgeOverlay = await buildPickedEdgeOverlay(
          fragModel,
          this.modelObject,
          edgeOverlayLocals,
          this.sketchEdgeMaterialPool,
        );
        this.modelObject.add(this.pickedEdgeOverlay);
      }
      if (options?.inspectionReadableSketch === true) {
        this.applySketchModeVisuals(this.sketchModeEnabled);
      }
      return true;
    }

    if (mode === "hidden") {
      const toHide = [...selected];
      await this.chunkInvokeIds(toHide, (slice) => fragModel.setVisible(slice, false));
      this.isolationVisualMode = "hidden";
      await this.syncFragmentsViewForced(fragments);
      const stillVisible = allIds.filter((id) => !selected.has(id));
      const focusSet = new Set(stillVisible);
      const focusMap = this.bboxMapFromLocalSet(focusSet);
      if (doFocus && focusSet.size > 0) {
        await this.focusBboxMap(focusMap);
        await this.syncFragmentsViewForced(fragments);
      }
      await this.deferSyncFragmentsView(fragments);
      this.syncSketchEdgeVisibilityToIsolationState();
      this.hiddenRemainderSketchNonce++;
      const hiddenSketchNonce = this.hiddenRemainderSketchNonce;
      await this.executeHiddenRemainderSketchOverlayRebuild(hiddenSketchNonce);
      return true;
    }

    /**
     * Context = ghost snapshot of the currently visible model + exact worker visibility for
     * the real selected item. This uses the same exact selection behavior as `בודד`, so the
     * picked element keeps its real material/color while the snapshot provides context.
     */
    await fragModel.setLodMode(LodMode.ALL_VISIBLE);
    await this.syncFragmentsViewForced(fragments);
    this.createContextGhostSnapshot();
    const toHide = allIds.filter((id) => !selected.has(id));
    await this.chunkInvokeIds(toHide, (slice) => fragModel.setVisible(slice, false));
    await this.syncFragmentsViewForced(fragments);
    this.isolationVisualMode = "context";
    if (doFocus && selected.size > 0) {
      await this.focusBboxMap(map);
    }
    /**
     * Match ghost face opacity on every sketch edge (LineBasic pool + LOD wire `lodOpacity`)
     * so the rest of the model reads as a faint sketch. The picked element's crisp 100% outline is
     * drawn on top by {@link buildPickedEdgeOverlay} — per-item geometry from `getItemsGeometry`,
     * so picking one bolt never lights up its tile-mates.
     */
    setContextIsolationEdgeOpacity(
      CONTEXT_GHOST_FACE_OPACITY,
      this.modelObject,
      this.sketchEdgeMaterialPool,
    );
    this.syncSketchEdgeVisibilityToIsolationState();
    if (this.modelObject) {
      this.pickedEdgeOverlay = await buildPickedEdgeOverlay(
        fragModel,
        this.modelObject,
        coreEdgeOverlayLocals,
        this.sketchEdgeMaterialPool,
      );
      this.modelObject.add(this.pickedEdgeOverlay);
    }
    return true;
  }

  /** Reset visibility, opacity overrides, and highlight (ThatOpen worker). */
  clearIsolationVisuals(): Promise<void> {
    return this.enqueueIsolation(async () => {
      try {
        this.inspectionIsolationSketchReadable = false;
        this.disposeProductionHoleOverlays();
        this.lastIsolatedVisibleLocals = null;
        this.clearContextMainThreadVisuals();
        this.shutdownHiddenRemainderSketchState();
        this.isolationVisualMode = "none";
        if (this.disposed || !this.modelId) {
          return;
        }
        const fragments = this.components.get(OBC.FragmentsManager);
        if (!fragments.initialized) {
          return;
        }
        const fragModel = fragments.list.get(this.modelId);
        await fragments.resetHighlight();
        if (fragModel) {
          await fragModel.resetVisible();
        }
        await this.syncFragmentsViewForced(fragments);
        await this.deferSyncFragmentsView(fragments);
      } finally {
        this.clearSelectionOutlineTint();
        this.syncSketchEdgeVisibilityToIsolationState();
      }
    });
  }

  /**
   * View filter (סינון תצוגה): reset fragment visibility, then hide the given locals.
   * `HasOpenings` / void companions are merged only from **`structuralHidden`** so the בורג fastener overlay
   * does not pull hole meshes into the hidden set.
   * Does not set {@link isolationVisualMode}; pair with UI that clears isolation highlight first.
   */
  applyViewVisibilityFilter(
    structuralHidden: Set<number>,
    fastenerHidden?: ReadonlySet<number>,
  ): Promise<void> {
    return this.enqueueIsolation(async () => {
      if (this.disposed || !this.modelId) return;
      const fragments = this.components.get(OBC.FragmentsManager);
      if (!fragments.initialized) return;
      const fragModel = fragments.list.get(this.modelId);
      if (!fragModel) return;

      const fasteners = fastenerHidden ?? new Set<number>();
      const hasFasteners = fasteners.size > 0;
      const hasStructural = structuralHidden.size > 0;
      const hasAnythingHidden = hasStructural || hasFasteners;

      this.viewFilterSuppressMainSketchEdges = hasAnythingHidden;
      disposePickedEdgeOverlay(this.viewFilterEdgeOverlay);
      this.viewFilterEdgeOverlay = null;

      await fragModel.resetVisible();
      await this.syncFragmentsViewForced(fragments);

      const allIds = await this.allFragmentLocalIds(fragModel);
      const allIdSet = new Set(allIds);
      const mergedHidden = new Set<number>();
      for (const id of structuralHidden) {
        if (allIdSet.has(id)) mergedHidden.add(id);
      }
      await this.mergeHostedOpeningLocalIds(fragModel, mergedHidden, allIdSet);

      for (const id of fasteners) {
        if (allIdSet.has(id)) mergedHidden.add(id);
      }

      const ids = [...mergedHidden];
      if (ids.length > 0) {
        await this.chunkInvokeIds(ids, (slice) => fragModel.setVisible(slice, false));
      }
      await this.syncFragmentsViewForced(fragments);
      await this.deferSyncFragmentsView(fragments);

      if (!this.modelObject || !this.sketchEdgesBuilt) {
        return;
      }

      if (mergedHidden.size === 0) {
        this.syncSketchEdgeVisibilityToIsolationState();
        return;
      }

      setSketchEdgeVisibility(this.modelObject, false);

      const hiddenSet = mergedHidden;
      const visibleIds = allIds.filter((id) => !hiddenSet.has(id));

      if (visibleIds.length === 0) {
        this.syncSketchEdgeVisibilityToIsolationState();
        return;
      }

      const overlay = await buildPickedEdgeOverlay(
        fragModel,
        this.modelObject,
        visibleIds,
        this.sketchEdgeMaterialPool,
        {
          yieldBetweenBatches: true,
          groupName: VIEW_FILTER_EDGE_OVERLAY_NAME,
        },
      );

      if (overlay.children.length > 0) {
        this.viewFilterEdgeOverlay = overlay;
        this.modelObject.add(overlay);
      }

      this.syncSketchEdgeVisibilityToIsolationState();
    });
  }

  async highlightAnalyzerSubset(entities: Iterable<{ id: string; expressId: number | null }>) {
    const modelId = this.modelId;
    if (!modelId) return;
    return this.enqueueIsolation(async () => {
      const fragments = this.components.get(OBC.FragmentsManager);
      const fragModel = fragments.list.get(modelId);

      const map = await this.modelIdMapForAnalyzerEntities(entities);
      const ids = map[modelId];
      if (!ids || ids.size === 0) {
        await fragments.resetHighlight();
        await this.syncFragmentsViewForced(fragments);
        this.clearPickedSelectionEdgeOverlay();
        this.clearSelectionOutlineTint();
        return;
      }

      await fragments.resetHighlight();
      await fragments.highlight(this.highlightMaterialParams(), map);
      await this.syncFragmentsViewForced(fragments);
      if (fragModel) {
        await this.rebuildPickedSelectionEdgeOverlay(fragModel, ids);
      }
    });
  }

  async highlightItemIds(itemIds: number[]) {
    if (!this.modelId) return;
    await this.highlightAnalyzerSubset(
      itemIds.map((expressId) => ({ id: "", expressId })),
    );
  }

  /**
   * Highlight an arbitrary set of fragment **local** ids (multi-select). Serialized with
   * isolation/highlight RPCs so active hide/isolate states can still accept a new candidate selection.
   */
  async highlightFragmentLocalSet(ids: Set<number>): Promise<void> {
    if (!this.modelId) return;
    return this.enqueueIsolation(async () => {
      if (this.disposed) return;
      const fragments = this.components.get(OBC.FragmentsManager);
      if (!fragments.initialized) return;
      const fragModel = this.modelId ? fragments.list.get(this.modelId) : null;

      if (ids.size === 0) {
        await fragments.resetHighlight();
        await this.syncFragmentsViewForced(fragments);
        this.clearPickedSelectionEdgeOverlay();
        this.clearSelectionOutlineTint();
        return;
      }

      await fragments.resetHighlight();
      await fragments.highlight(this.highlightMaterialParams(), this.bboxMapFromLocalSet(ids));
      await this.syncFragmentsViewForced(fragments);
      if (fragModel) {
        await this.rebuildPickedSelectionEdgeOverlay(fragModel, ids);
      }
    });
  }

  async clearHighlight() {
    const fragments = this.components.get(OBC.FragmentsManager);
    await fragments.resetHighlight();
    await this.syncFragmentsViewForced(fragments);
    this.clearPickedSelectionEdgeOverlay();
    this.clearSelectionOutlineTint();
  }

  async focusAnalyzerSubset(entities: Iterable<{ id: string; expressId: number | null }>) {
    if (!this.modelId) return;
    const map = await this.modelIdMapForAnalyzerEntities(entities);
    await this.focusBboxMap(map);
  }

  /**
   * Iso-diagonal framing on a specific analyzer subset (assemblies / parts / bolts).
   *
   * Unlike {@link focusBboxMap}, this uses the same camera math as the initial model fit
   * ({@link frameCameraIsoDiagonal}): camera distance = `radius * 1.55`, eye on the
   * `(1, 1, 1)` diagonal, world up = `+Y`, focal offset cleared. Produces the same auto-centered
   * isometric pose the user sees on first model load, but for a single subset — used by
   * מצב ייצור so picking an assembly/part snaps the camera straight to a clean, view-filling
   * pose instead of leaving the part wherever it sat in the parent model.
   *
   * Sticky orbit pivot is re-seeded at the subset center so the very first orbit gesture after
   * this call honors the focused subset (same pattern as `focusBboxMap`).
   */
  async frameAnalyzerSubsetIso(
    entities: Iterable<{ id: string; expressId: number | null }>,
  ): Promise<boolean> {
    if (this.disposed || !this.modelId) return false;
    const fragments = this.components.get(OBC.FragmentsManager);
    if (!fragments.initialized) return false;
    const map = await this.modelIdMapForAnalyzerEntities(entities);
    const set = map[this.modelId];
    if (!set || set.size === 0) return false;

    try {
      const boxes = await fragments.getBBoxes(map);
      if (!boxes.length) return false;
      const aggregate = new THREE.Box3();
      for (const box of boxes) aggregate.union(box);
      if (aggregate.isEmpty()) return false;

      const sphere = aggregate.getBoundingSphere(new THREE.Sphere());
      const radius = Math.max(sphere.radius, 1);

      if (this.modelObject) this.applyPerspectiveClipPlanes(this.modelObject);
      this.frameCameraIsoDiagonal(sphere.center, radius);

      const ctrl = this.world.camera.controls;
      if (ctrl) {
        ctrl.setFocalOffset(0, 0, 0, false);
        ctrl.setOrbitPoint(sphere.center.x, sphere.center.y, sphere.center.z);
        void ctrl.stop?.();
        void ctrl.update?.(0);
      }

      /** Same seed pattern as {@link focusBboxMap} — keeps the next orbit gesture on this subset. */
      this.pickOrbitPivotWorld.copy(sphere.center);
      this.pickOrbitPivotActive = true;

      void fragments.core.update(true);
      return true;
    } catch (error) {
      console.error("frameAnalyzerSubsetIso failed:", error);
      return false;
    }
  }

  async showOnlyAnalyzerSubset(
    entities: Iterable<{ id: string; expressId: number | null }>,
  ): Promise<boolean> {
    if (this.disposed || !this.modelId) return false;
    const fragments = this.components.get(OBC.FragmentsManager);
    const fragModel = fragments.list.get(this.modelId);
    if (!fragModel) return false;

    const map = await this.modelIdMapForAnalyzerEntities(entities);
    const selected = new Set(map[this.modelId] ?? []);
    if (selected.size === 0) return false;

    this.clearStoredPickOrbitPivot();
    this.inspectionIsolationSketchReadable = false;
    this.shutdownHiddenRemainderSketchState();
    this.clearContextMainThreadVisuals();
    this.clearPickedSelectionEdgeOverlay();
    this.clearSelectionOutlineTint();
    this.isolationVisualMode = "none";
    if (this.modelObject) {
      setSketchEdgeVisibility(this.modelObject, false);
    }

    await fragments.resetHighlight();
    await fragModel.resetVisible();
    await this.syncFragmentsViewForced(fragments);

    const allIds = await this.allFragmentLocalIds(fragModel);
    const allIdSet = new Set(allIds);
    const visible = new Set<number>();
    for (const id of selected) {
      if (allIdSet.has(id)) visible.add(id);
    }
    if (visible.size === 0) return false;

    const toHide = allIds.filter((id) => !visible.has(id));
    await this.chunkInvokeIds(toHide, (slice) => fragModel.setVisible(slice, false));
    await this.syncFragmentsViewForced(fragments);
    await this.focusBboxMap(this.bboxMapFromLocalSet(visible));
    await this.syncFragmentsViewForced(fragments);
    await this.deferSyncFragmentsView(fragments);
    return true;
  }

  async focusItemIds(itemIds: number[]) {
    await this.focusAnalyzerSubset(itemIds.map((expressId) => ({ id: "", expressId })));
  }

  setMode(mode: ViewerMode) {
    if (this.disposed) return;
    void mode;
  }

  setCategoryVisible(category: string, visible: boolean) {
    if (this.disposed) return;
    void category;
    void visible;
  }

  setTransparency(enabled: boolean) {
    if (this.disposed) return;
    if (!this.modelObject) return;
    if (this.sketchModeEnabled) return;
    if (this.isolationVisualMode !== "none") return;
    this.modelObject.traverse((child: THREE.Object3D) => {
      const mesh = child as THREE.Mesh;
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (!material) return;
      const setAlpha = (mat: THREE.Material) => {
        const m = mat as THREE.MeshStandardMaterial;
        m.transparent = enabled;
        m.opacity = enabled ? 0.35 : 1;
      };
      if (Array.isArray(material)) material.forEach(setAlpha);
      else setAlpha(material);
    });
  }

  resetView() {
    if (this.disposed) return;
    this.clearStoredPickOrbitPivot();
    if (this.activeOrthoViewMode !== null) {
      this.exitViewMode();
      return;
    }
    if (this.modelObject) {
      this.applyPerspectiveClipPlanes(this.modelObject);
      const box = new THREE.Box3().setFromObject(this.modelObject);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      this.frameCameraIsoDiagonal(sphere.center, sphere.radius);
      const ctrl = this.world.camera.controls;
      if (ctrl) {
        void (ctrl as CameraControls).stop?.();
        ctrl.setFocalOffset(0, 0, 0, false);
        void ctrl.update?.(0);
        void ctrl.update?.(1 / 60);
      }
      this.applySnappyCameraControls();
      this.syncPerspectiveOrbitLimitsClipAndSensitivity();
      this.boundUseCamera?.(this.world.camera.three as THREE.PerspectiveCamera);
      void this.syncFragmentsAfterCameraSwap();
      return;
    }
    const cam = this.world.camera.three as THREE.PerspectiveCamera;
    cam.up.set(0, 1, 0);
    this.world.scene.three.up.set(0, 1, 0);
    this.world.camera.controls?.updateCameraUp();
    this.world.camera.controls?.setLookAt(14, 14, 14, 0, 0, 0, false);
  }

  fitAll() {
    if (this.disposed) return;
    if (!this.modelObject) return;
    if (this.activeOrthoViewMode !== null) {
      this.exitViewMode();
      return;
    }
    this.fitAllPerspective();
  }

  dispose() {
    if (this.disposed) return;
    this.cameraSensitivityRefDistance = 25;
    this.clearStoredPickOrbitPivot();
    this.clearInspectionVisualizationSession();
    this.disposeProductionHoleOverlays();
    this.shutdownHiddenRemainderSketchState();
    this.clearContextMainThreadVisuals();
    void this.clearIsolationVisuals();
    this.clearClipping();
    this.disposed = true;
    this.analyzerGuidKeyToFragmentLocal.clear();
    try {
      if (this.viewerTool === "measurement") {
        const ctrl = this.world.camera.controls;
        if (ctrl && this.measurementSuppressedControls) {
          ctrl.enabled = this.measurementControlsEnabledSnapshot;
        }
        this.measurementSuppressedControls = false;
      }
      this.viewerTool = "none";
      this.measurementSessionCameraRevert = null;
      this.measurementController.shutdown();
      this.detachSketchTilesListener();
      if (this.activeOrthoViewMode !== null) {
        this.detachOrthoResizeListener();
        this.activeOrthoViewMode = null;
        const simpleCam = this.world.camera as OBC.SimpleCamera;
        simpleCam.three = this.perspectiveCamera;
        const ctrl = simpleCam.controls;
        if (ctrl) {
          ctrl.camera = this.perspectiveCamera;
          this.applyPerspectiveNavigationBindings(ctrl);
          this.resetPerspectiveZoomForControls(ctrl);
        }
        this.perspectiveCamera.up.set(0, 1, 0);
        (this.world.scene.three as THREE.Scene).up.set(0, 1, 0);
        ctrl?.updateCameraUp();
        if (this.boundUseCamera) this.boundUseCamera(this.perspectiveCamera);
        const fragments = this.components.get(OBC.FragmentsManager);
        if (fragments.initialized) void fragments.core.update(true);
      }
      if (this.modelObject) {
        stripSketchEdgeChildren(this.modelObject);
      }
      for (const [mat, opacity] of this.sketchLodOpacityBackup) {
        (mat as THREE.Material & { lodOpacity: number }).lodOpacity = opacity;
      }
      this.sketchLodOpacityBackup.clear();
      this.sketchFillMaterial?.dispose();
      this.sketchFillMaterial = null;
      this.disposeSketchEdgeMaterialPool();
      this.sketchMaterialBackup.clear();
      this.sketchEdgesBuilt = false;
      (this.world.scene.three as THREE.Scene).background = this.sceneBackdropDefault;
      for (const L of this.viewerLights) {
        L.visible = true;
      }
      for (const light of this.viewerLights) {
        this.world.scene.three.remove(light);
        light.dispose();
      }
      this.viewerLights.length = 0;
      if (this.modelObject) {
        this.world.scene.three.remove(this.modelObject);
        this.modelObject = null;
      }
      this.removePointerListeners();
      if (this.orthoViewWheelCaptureHandler) {
        this.container.removeEventListener("wheel", this.orthoViewWheelCaptureHandler, {
          capture: true,
        });
        this.orthoViewWheelCaptureHandler = null;
      }
      if (this.wheelDollyPivotReseedHandler) {
        window.removeEventListener("wheel", this.wheelDollyPivotReseedHandler, { capture: true });
        this.wheelDollyPivotReseedHandler = null;
      }
      const camCtrl = this.world.camera.controls as CameraControls | undefined;
      if (camCtrl && this.orbitPivotControlStartHandler) {
        camCtrl.removeEventListener("controlstart", this.orbitPivotControlStartHandler);
        this.orbitPivotControlStartHandler = null;
      }
      this.world.renderer?.dispose();
      this.world.camera.controls?.dispose();
    } catch {
      // Guard against teardown edge-cases in React strict-mode remounts.
    }
  }
}
