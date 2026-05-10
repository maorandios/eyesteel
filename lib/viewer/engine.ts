"use client";

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import CameraControls from "camera-controls";
import { LodMode, type FragmentsModel } from "@thatopen/fragments";
import type { AnalyzerOutput, ViewerMode } from "@/types/domain";
import { loadIfcModel } from "@/lib/viewer/ifc-loader";
import { normalizeIfcGuidKey } from "@/lib/viewer/ifc-guid";
import { MeasurementController } from "@/lib/viewer/measurement/measurement-controller";
import {
  CONTEXT_GHOST_FACE_OPACITY,
  CONTEXT_GHOST_SNAPSHOT_NAME,
  EYE_STEEL_SCENE_BACKGROUND_HEX,
  applyEyeSteelRendererDefaults,
  applyEyeSteelSceneBackdrop,
  buildSelectionHighlightMaterial,
  createEyeSteelLights,
} from "@/lib/viewer/visual-policy";
import {
  attachSketchEdges,
  createSketchFillMaterial,
  ensureSketchEdgesAttached,
  isLodFragmentMaterial,
  restoreSelectionTintOnSketchLineSegments,
  setContextIsolationEdgeOpacity,
  setSketchEdgeVisibility,
  stripSketchEdgeChildren,
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
  CLIPPING_LABELS_HE,
  type ClippingDirectionId,
  type ViewerClippingUiSnapshot,
  normalForClippingDirection,
} from "@/lib/viewer/clipping-presets";
import type { IsolationMode } from "@/lib/state/isolation-store";

export interface PickHit {
  localId: number;
  itemId: number;
}

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
};

export type ViewerToolMode = "none" | "measurement";

/** Tap classification — fingers jitter more than mouse cursors. */
const TAP_SLOP_SQ_MOUSE = 144;
const TAP_SLOP_SQ_TOUCH = 900;
const TAP_MAX_MS_MOUSE = 700;
const TAP_MAX_MS_TOUCH = 950;

const ORTHO_MARGIN = 1.08;
const ORTHO_DISTANCE_K = 1.75;

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
  private downPos: { x: number; y: number; t: number; pointerType: string } | null = null;
  private pickCallback: ((hit: PickHit | null) => void) | null = null;
  private fragmentCameraHooksInstalled = false;
  /** `FragmentsManager.list` is only valid after {@link OBC.FragmentsManager.init}. */
  private fragmentsClippingListenersInstalled = false;
  private readonly measurementController: MeasurementController;
  private viewerTool: ViewerToolMode = "none";
  /** Restore after measurement — only used when we disable orbit on touch (see measurementSuppressedControls). */
  private measurementControlsEnabledSnapshot = true;
  /** True only when measurement mode disabled orbit for a coarse-pointer UI; desktop keeps orbiting. */
  private measurementSuppressedControls = false;
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
  private readonly tmpVecEye = new THREE.Vector3();
  private readonly tmpClipNormal = new THREE.Vector3();

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
    this.installOrbitPivotOnRotateStart();

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
      persp.far = Math.max(5e4, span * 100, 1e6);
    } else {
      persp.far = 1e6;
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

  private updateOrthoFrustum(box: THREE.Box3) {
    const renderer = this.world.renderer as OBF.RendererWith2D;
    const el = renderer.container;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const aspect = w > 0 && h > 0 ? w / h : 1;
    this.updateOrthoFrustumForAspect(box, aspect);
  }

  private updateOrthoFrustumForAspect(box: THREE.Box3, aspect: number) {
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const halfBase = 0.5 * maxDim * ORTHO_MARGIN;
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

  private attachOrthoResizeListener() {
    this.detachOrthoResizeListener();
    const renderer = this.world.renderer as OBF.RendererWith2D;
    this.orthoResizeHandler = () => {
      if (this.disposed || !this.modelObject || this.activeOrthoViewMode === null) return;
      const box = new THREE.Box3().setFromObject(this.modelObject);
      if (!box.isEmpty()) this.updateOrthoFrustum(box);
    };
    renderer.onResize.add(this.orthoResizeHandler);
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
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1);
    const distance = ORTHO_DISTANCE_K * span;

    this.updateOrthoFrustum(box);

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

    this.boundUseCamera?.(ortho);
    this.syncFragmentsAfterCameraSwap();

    this.activeOrthoViewMode = mode;
    this.attachOrthoResizeListener();
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

    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z, 1);
    const distance = ORTHO_DISTANCE_K * span;

    this.updateOrthoFrustum(box);

    const mode = this.userClipDirection;
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

    this.boundUseCamera?.(ortho);
    this.syncFragmentsAfterCameraSwap();

    this.activeOrthoViewMode = mode;
    this.attachOrthoResizeListener();
    return true;
  }

  /** Restore perspective camera, fragment projection, and iso frame (same as exiting מבט). */
  exitViewMode(): void {
    if (this.disposed || this.activeOrthoViewMode === null) return;
    this.detachOrthoResizeListener();
    this.activeOrthoViewMode = null;

    const simpleCam = this.world.camera as OBC.SimpleCamera;
    const ctrl = simpleCam.controls;
    simpleCam.three = this.perspectiveCamera;
    if (ctrl) {
      ctrl.camera = this.perspectiveCamera;
      this.applyPerspectiveNavigationBindings(ctrl);
    }

    this.perspectiveCamera.up.set(0, 1, 0);
    (this.world.scene.three as THREE.Scene).up.set(0, 1, 0);
    ctrl?.updateCameraUp();

    this.boundUseCamera?.(this.perspectiveCamera);
    this.syncFragmentsAfterCameraSwap();

    if (this.modelObject) this.fitAllPerspective();
  }

  /** Library sets smoothTime=0.2 on CameraControls — feels sluggish while orbiting. */
  private applySnappyCameraControls() {
    const c = this.world.camera.controls;
    if (!c) return;
    c.smoothTime = 0;
    c.draggingSmoothTime = 0;
    /**
     * Defaults are minDistance=6 + infinityDolly=true so dollying inside minDistance pushes the orbit target —
     * the pivot slides away from the steel you framed and orbit feels broken.
     */
    c.minDistance = 0.05;
    c.infinityDolly = false;
  }

  /** Rotate gestures orbit around the surface point under the cursor (desktop + touch). */
  private installOrbitPivotOnRotateStart() {
    const controls = this.world.camera.controls;
    if (!controls) return;
    const onRotateStart = () => {
      const action = controls.currentAction;
      const A = CameraControls.ACTION;
      const isRotate =
        action === A.ROTATE ||
        action === A.TOUCH_ROTATE ||
        action === A.TOUCH_DOLLY_ROTATE ||
        action === A.TOUCH_ZOOM_ROTATE;
      if (!isRotate) return;
      const fragments = this.components.get(OBC.FragmentsManager);
      if (!fragments.initialized || this.disposed) return;
      void (async () => {
        try {
          const pickers = this.components.get(OBC.FastModelPickers);
          const picker = pickers.get(this.world);
          const pt = await picker.getPointAt(this.lastPointerNdc.clone());
          if (pt && !this.disposed) controls.setOrbitPoint(pt.x, pt.y, pt.z);
        } catch {
          /* picker GPU passes may fail transiently */
        }
      })();
    };
    controls.addEventListener("controlstart", onRotateStart);
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
    const ctrl = this.world.camera.controls;
    const cam = this.world.camera.three as THREE.PerspectiveCamera;
    this.world.scene.three.up.set(0, 1, 0);
    cam.up.set(0, 1, 0);
    ctrl?.updateCameraUp();
    const dist = Math.max(radius * 1.55, 8);
    const dir = new THREE.Vector3(1, 1, 1).normalize();
    const eye = center.clone().addScaledVector(dir, dist);
    ctrl?.setOrbitPoint(center.x, center.y, center.z);
    ctrl?.setLookAt(eye.x, eye.y, eye.z, center.x, center.y, center.z, false);
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
    for (const m of this.sketchEdgeMaterialPool.values()) m.dispose();
    this.sketchEdgeMaterialPool.clear();
  }

  /**
   * Per-mode sketch edge visibility:
   * - **`isolated`**: hide every main-view sketch edge. The picked element's outline is drawn by
   *   {@link buildPickedEdgeOverlay} on top, so non-picked tile-mates can never bleed through
   *   (which would happen with `itemFilter`-based hiding because shell meshes don't carry one).
   * - **`context`**: keep edges visible — they're dimmed to 15% via
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
    let overlay = await buildPickedEdgeOverlay(
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

    let onViewUpdated: () => void;
    let onTileSet: () => void;

    const cleanup = () => {
      fragModel.onViewUpdated.remove(onViewUpdated);
      fragModel.tiles.onItemSet.remove(onTileSet);
      this.sketchTilesUnsub = null;
    };

    onViewUpdated = () => {
      if (this.disposed) {
        cleanup();
        return;
      }
      this.syncSketchEdgesForNewTiles();
    };

    onTileSet = () => {
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
            mat.lodOpacity = 0;
          }
        } else {
          if (!fill) return;
          mesh.material = Array.isArray(orig) ? origList.map(() => fill) : fill;
        }
      });

      this.syncSketchEdgeVisibilityToIsolationState();
    } else {
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

  /** Sketch: transparent LOD faces + element-colored edges (face ×0.48). Default: solid shading + same edges. */
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

  /** Measurement on touch: orbit off so gestures don't fight taps. Desktop: keep orbiting when allowed. */
  setViewerTool(tool: ViewerToolMode) {
    if (this.disposed) return;
    this.viewerTool = tool;
    const ctrl = this.world.camera.controls;

    if (tool === "measurement") {
      if (ctrl && MeasurementController.prefersTouchLikeMeasurement()) {
        this.measurementControlsEnabledSnapshot = ctrl.enabled;
        ctrl.enabled = false;
        this.measurementSuppressedControls = true;
      }
      this.reinstateCanvasTouchBlocking();
      this.measurementController.activate();
    } else {
      this.measurementController.deactivate();
      if (ctrl && this.measurementSuppressedControls) {
        ctrl.enabled = this.measurementControlsEnabledSnapshot;
        this.measurementSuppressedControls = false;
      }
    }
  }

  getViewerTool(): ViewerToolMode {
    return this.viewerTool;
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
      if (event.button !== 0 && event.pointerType === "mouse") return;
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

      if (this.viewerTool === "measurement") {
        this.commitMeasurementTap(canvas, useX, useY, event);
        return;
      }

      if (!this.pickCallback) return;

      const mouse = new THREE.Vector2(
        ((useX - rect.left) / rect.width) * 2 - 1,
        -((useY - rect.top) / rect.height) * 2 + 1,
      );
      let hit: { localId: number; itemId: number } | null = null;
      try {
        const pickers = this.components.get(OBC.FastModelPickers);
        const picker = pickers.get(this.world);
        const full = await picker.getFullPick(mouse);
        if (full && typeof full.localId === "number") {
          hit = { localId: full.localId, itemId: full.itemId };
          const c = this.world.camera.controls;
          if (c) c.setOrbitPoint(full.point.x, full.point.y, full.point.z);
        }
      } catch (error) {
        console.error("[picker] gpu pick failed:", error);
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
    const list = [...entities];
    const guids = [...new Set(list.map((e) => e.id).filter((g) => g.length > 0))];
    const fromGuids =
      guids.length > 0 ? await fragments.guidsToModelIdMap(guids) : ({} as Record<string, Set<number>>);
    const set = new Set<number>([...(fromGuids[this.modelId] ?? [])]);
    for (const e of list) {
      if (e.expressId != null) set.add(e.expressId);
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
  }

  getIsolationVisualMode(): IsolationMode {
    return this.isolationVisualMode;
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
   */
  async resolveMechanicalFastenerLocalsToHide(): Promise<Set<number>> {
    if (!this.modelId) return new Set();
    const fragments = this.components.get(OBC.FragmentsManager);
    const fragModel = fragments.list.get(this.modelId);
    if (!fragModel) return new Set();

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

          const blob = ViewerEngine.stringifyItemAttributesForBoltHoleGuess(attrs);
          const isDiscrete = cat.toUpperCase().includes("DISCRETEACCESSORY");
          if (isDiscrete && blob.length < 28) {
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
          out.add(lid);
        }
      } catch {
        /* On failure keep ambiguous discrete visible (likely bore meshes with sparse summaries). */
      }
    }

    return out;
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
          if (constrainBolts && !this.isDiscreteAccessoryCategory(raw.category)) {
            const g = normalizeIfcGuidKey(
              typeof raw.guid === "string" ? raw.guid : null,
            );
            if (!g || !boltGuidIsolationAllowlist!.has(g)) continue;
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

    let core: THREE.Box3;
    try {
      core = await fragModel.getMergedBox(seeds);
    } catch {
      return;
    }
    const diagonal = core.getSize(new THREE.Vector3()).length();
    if (!Number.isFinite(diagonal) || diagonal <= Number.EPSILON) return;

    /** Slight inflate for LOD / triangle hull vs IFC solid (keep small). */
    const meshSlop = THREE.MathUtils.clamp(diagonal * 0.012, diagonal * 0.004, diagonal * 0.028);
    core.expandByScalar(meshSlop);

    /**
     * Max distance bolt center may sit beyond the inflated steel box while still belonging to this
     * member (nut stack offset from flange). Cap absolute so IFC metres stay sane on long members.
     */
    const maxCenterDetach = THREE.MathUtils.clamp(
      diagonal * 0.055,
      0.004,
      Math.min(0.22, diagonal * 0.12),
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
      !b.isEmpty() && b.getSize(new THREE.Vector3()).length() < diagonal * 0.085;

    const removable: number[] = [];
    const ITEM_CHUNK = 220;
    const boltCenter = new THREE.Vector3();
    const hullClosest = new THREE.Vector3();

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
        core.clampPoint(boltCenter, hullClosest);
        if (boltCenter.distanceToSquared(hullClosest) > maxDetachSq) removable.push(lid);
      }
    }
    for (const lid of removable) locals.delete(lid);
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

  /** Semi-transparent context overlay: same IFC hue as the source tile, ~15% opacity (see visual-policy). */
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
    if (this.disposed || !this.modelId || localIds.size === 0) {
      return false;
    }
    const fragments = this.components.get(OBC.FragmentsManager);
    const fragModel = fragments.list.get(this.modelId);
    if (!fragModel) {
      return false;
    }
    const doFocus = options?.focus !== false;

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
      return false;
    }

    const isolationSeedLocals = [...selected];
    const coreEdgeOverlayLocals = [...selected];
    const boltAllow = options?.boltGuidIsolationAllowlist;
    const spatialBoltAllow = options?.spatialBoltIsolationAllowlist;
    const useIfcBoltRel = !!options?.useIfcBoltSteelRelationIsolation;
    /**
     * Strict per-fragment GUID filter breaks when exporter GUIDs diverge from the analyzer JSON;
     * relation mode relies on IFC `ConnectedTo` from the isolated steel (+ injected locals) instead.
     */
    const graphBoltGuidAllowlist = useIfcBoltRel ? undefined : boltAllow;
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

    if (mode === "hidden") {
      this.isolationHiddenExcludedLocals = new Set(selected);
    }

    const map = this.bboxMapFromLocalSet(selected);

    if (mode === "isolated") {
      const toHide = allIds.filter((id) => !selected.has(id));
      await this.chunkInvokeIds(toHide, (slice) => fragModel.setVisible(slice, false));
      this.isolationVisualMode = "isolated";
      await this.syncFragmentsViewForced(fragments);
      if (doFocus) {
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
    if (doFocus) {
      await this.focusBboxMap(map);
    }
    /**
     * Match the 15% ghost face opacity on every sketch edge (LineBasic pool + LOD wire `lodOpacity`)
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

      const map = await this.modelIdMapForAnalyzerEntities(entities);
      const ids = map[modelId];
      if (!ids || ids.size === 0) {
        await fragments.resetHighlight();
        await this.syncFragmentsViewForced(fragments);
        this.clearSelectionOutlineTint();
        return;
      }

      if (this.isolationVisualMode !== "none") {
        await this.applyIsolationImpl(this.isolationVisualMode, ids, { focus: false });
        return;
      }

      await fragments.resetHighlight();
      await fragments.highlight(this.highlightMaterialParams(), map);
      await this.syncFragmentsViewForced(fragments);
    });
  }

  async highlightItemIds(itemIds: number[]) {
    if (!this.modelId) return;
    await this.highlightAnalyzerSubset(
      itemIds.map((expressId) => ({ id: "", expressId })),
    );
  }

  /**
   * Highlight an arbitrary set of fragment **local** ids (multi-select). No-op when isolation visuals
   * are active — user should reset view first. Serialized with isolation/highlight RPCs.
   */
  async highlightFragmentLocalSet(ids: Set<number>): Promise<void> {
    if (!this.modelId) return;
    return this.enqueueIsolation(async () => {
      if (this.disposed) return;
      const fragments = this.components.get(OBC.FragmentsManager);
      if (!fragments.initialized) return;
      if (this.isolationVisualMode !== "none") return;

      if (ids.size === 0) {
        await fragments.resetHighlight();
        await this.syncFragmentsViewForced(fragments);
        this.clearSelectionOutlineTint();
        return;
      }

      await fragments.resetHighlight();
      await fragments.highlight(this.highlightMaterialParams(), this.bboxMapFromLocalSet(ids));
      await this.syncFragmentsViewForced(fragments);
    });
  }

  async clearHighlight() {
    const fragments = this.components.get(OBC.FragmentsManager);
    await fragments.resetHighlight();
    await this.syncFragmentsViewForced(fragments);
    this.clearSelectionOutlineTint();
  }

  async focusAnalyzerSubset(entities: Iterable<{ id: string; expressId: number | null }>) {
    if (!this.modelId) return;
    const map = await this.modelIdMapForAnalyzerEntities(entities);
    await this.focusBboxMap(map);
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
    if (this.activeOrthoViewMode !== null) {
      this.exitViewMode();
      return;
    }
    if (this.modelObject) {
      const box = new THREE.Box3().setFromObject(this.modelObject);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      this.frameCameraIsoDiagonal(sphere.center, sphere.radius);
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
      this.world.renderer?.dispose();
      this.world.camera.controls?.dispose();
    } catch {
      // Guard against teardown edge-cases in React strict-mode remounts.
    }
  }
}
