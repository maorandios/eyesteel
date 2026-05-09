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
  syncSketchEdgeVisibilityFromLodFilter,
  stripSketchEdgeChildren,
} from "@/lib/viewer/sketch-mode";
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
   * - **`isolated`**: drive visibility from the worker's `itemFilter` (Option B). Tiles whose every
   *   instance is culled hide their edges; mixed tiles rely on the LOD wire shader's
   *   `itemFilter == 0 → gl_Position = vec4(0)` early-out.
   * - **`context`**: keep all sketch edges visible — non-picked items are dimmed via
   *   {@link setContextIsolationEdgeOpacity} to match the 15% ghost face overlay.
   * - **`none`**: all edges visible at full opacity (live `lodColor` per element).
   */
  private syncSketchEdgeVisibilityToIsolationState(): void {
    if (!this.modelObject) return;
    if (this.isolationVisualMode === "isolated") {
      syncSketchEdgeVisibilityFromLodFilter(this.modelObject);
    } else {
      setSketchEdgeVisibility(this.modelObject, true);
    }
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
  private syncSketchEdgesForNewTiles(): void {
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
        if (!this.disposed) this.syncSketchEdgesForNewTiles();
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

  private bboxMapFromLocalSet(selected: Set<number>): Record<string, Set<number>> {
    if (!this.modelId) return {};
    return { [this.modelId]: new Set(selected) };
  }

  /** Full model id list from worker — avoids `getItemsByVisibility` after `resetVisible` (stale until tiles sync). */
  private async allFragmentLocalIds(fragModel: FragmentsModel): Promise<number[]> {
    const raw = await fragModel.getLocalIds();
    return Array.isArray(raw) ? (raw as number[]) : [];
  }

  private clearContextMainThreadVisuals(): void {
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
   * (no blue highlight). Default tile sketch edges are off (avoids leaking hidden geometry); picked
   * locals get a dedicated edge overlay. Context: ghost snapshot faces + same overlay on picked.
   */
  applyIsolation(
    mode: "isolated" | "context",
    localIds: Set<number>,
    options?: { focus?: boolean },
  ): Promise<boolean> {
    return this.enqueueIsolation(() => this.applyIsolationImpl(mode, localIds, options));
  }

  private async applyIsolationImpl(
    mode: "isolated" | "context",
    localIds: Set<number>,
    options?: { focus?: boolean },
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
    const prevIsolationVisual = this.isolationVisualMode;
    await fragments.resetHighlight();
    /**
     * `resetVisible` → worker `tiles.restart()` → `_meshConnection.clean()`. That is required when
     * leaving **בודד** (`setVisible` hides), but after **הצג הכל** it only adds an extra restart on
     * top of highlight restore and tends to break repeat **הצג בהקשר** (`setOpacity` stops
     * affecting the GL view even though invokes succeed).
     */
    const mustResetVisible = mode === "isolated" || prevIsolationVisual === "isolated";
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
      return false;
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
     * so the rest of the model reads as a faint sketch. The picked element keeps a 100% face that
     * still pops visually against the dimmed edges + ghosts.
     */
    setContextIsolationEdgeOpacity(
      CONTEXT_GHOST_FACE_OPACITY,
      this.modelObject,
      this.sketchEdgeMaterialPool,
    );
    this.syncSketchEdgeVisibilityToIsolationState();
    return true;
  }

  /** Reset visibility, opacity overrides, and highlight (ThatOpen worker). */
  clearIsolationVisuals(): Promise<void> {
    return this.enqueueIsolation(async () => {
      try {
        this.clearContextMainThreadVisuals();
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
