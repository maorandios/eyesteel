"use client";

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import CameraControls from "camera-controls";
import { LodMode } from "@thatopen/fragments";
import type { ViewerMode } from "@/types/domain";
import { loadIfcModel } from "@/lib/viewer/ifc-loader";
import {
  SELECTION_HIGHLIGHT_COLOR,
  applyEyeSteelRendererDefaults,
  applyEyeSteelSceneBackdrop,
  createEyeSteelLights,
} from "@/lib/viewer/visual-policy";

interface PickHit {
  localId: number;
  itemId: number;
}

export class ViewerEngine {
  private readonly container: HTMLDivElement;
  private readonly components: OBC.Components;
  private world!: OBC.World;
  private modelObject: THREE.Object3D | null = null;
  private modelId: string | null = null;
  private disposed = false;
  private readonly viewerLights: THREE.Light[] = [];

  private pointerDownHandler: ((event: PointerEvent) => void) | null = null;
  private pointerMoveHandler: ((event: PointerEvent) => void) | null = null;
  private pointerUpHandler: ((event: PointerEvent) => void) | null = null;
  private readonly lastPointerNdc = new THREE.Vector2(0, 0);
  private downPos: { x: number; y: number; t: number } | null = null;
  private pickCallback: ((hit: PickHit) => void) | null = null;
  private fragmentCameraHooksInstalled = false;

  constructor(container: HTMLDivElement) {
    this.container = container;
    this.components = new OBC.Components();
    this.setupWorld();
  }

  private setupWorld() {
    const worlds = this.components.get(OBC.Worlds);
    this.world = worlds.create<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>();
    this.world.scene = new OBC.SimpleScene(this.components);
    this.world.renderer = new OBC.SimpleRenderer(this.components, this.container);
    this.world.camera = new OBC.SimpleCamera(this.components);

    this.components.init();
    (this.world.scene as OBC.SimpleScene).setup();
    this.world.camera.controls?.setLookAt(18, 18, 18, 0, 0, 0, false);
    this.applySnappyCameraControls();
    this.applyPerspectiveClipPlanes();
    this.installFragmentCameraSyncOnce();
    this.installOrbitPivotOnRotateStart();

    const scene = this.world.scene.three as THREE.Scene;
    applyEyeSteelSceneBackdrop(scene);
    this.viewerLights.push(...createEyeSteelLights(scene));

    const renderer = this.world.renderer as OBC.SimpleRenderer;
    applyEyeSteelRendererDefaults(renderer.three);
    renderer.onResize.add(() => applyEyeSteelRendererDefaults(renderer.three));

    this.installPointerListeners();
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
      void fragments.core.update();
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

  async loadFile(file: File) {
    if (this.disposed) return;
    const { model } = await loadIfcModel(this.components, file);
    const casted = model as {
      modelId: string;
      object: THREE.Object3D;
      useCamera: (cam: THREE.PerspectiveCamera | THREE.OrthographicCamera) => void;
    };
    if (this.modelObject) this.world.scene.three.remove(this.modelObject);
    this.modelObject = casted.object;
    this.modelId = casted.modelId;
    this.world.scene.three.add(casted.object);

    const cam = this.world.camera.three;
    if (cam && (cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
      casted.useCamera(cam as THREE.PerspectiveCamera);
    } else if (cam) {
      casted.useCamera(cam as THREE.OrthographicCamera);
    }

    const fragments = this.components.get(OBC.FragmentsManager);
    void fragments.core.update(true);

    const fragModel = fragments.list.get(casted.modelId);
    if (fragModel) await fragModel.setLodMode(LodMode.ALL_VISIBLE);

    this.applyPerspectiveClipPlanes(casted.object);

    this.tuneReadableSteelMaterials(casted.object);

    this.fitAll();
  }

  getModelId() {
    return this.modelId;
  }

  setPickCallback(cb: ((hit: PickHit) => void) | null) {
    this.pickCallback = cb;
  }

  private installPointerListeners() {
    const canvas = this.world.renderer?.three?.domElement as HTMLCanvasElement | undefined;
    if (!canvas) return;

    const syncNdc = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      this.lastPointerNdc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    this.pointerMoveHandler = (event: PointerEvent) => syncNdc(event);

    this.pointerDownHandler = (event: PointerEvent) => {
      syncNdc(event);
      if (event.button !== 0 && event.pointerType === "mouse") return;
      this.downPos = { x: event.clientX, y: event.clientY, t: Date.now() };
    };

    this.pointerUpHandler = async (event: PointerEvent) => {
      if (!this.downPos) return;
      const dx = event.clientX - this.downPos.x;
      const dy = event.clientY - this.downPos.y;
      const dt = Date.now() - this.downPos.t;
      const start = this.downPos;
      this.downPos = null;

      const distSq = dx * dx + dy * dy;
      const isTap = distSq <= 144 && dt <= 700;
      if (!isTap) return;

      const renderer = this.world.renderer;
      const camera = this.world.camera;
      if (!renderer?.three || !camera?.three) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const useX = event.clientX || start.x;
      const useY = event.clientY || start.y;

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

      if (!hit) return;
      try {
        this.pickCallback(hit);
      } catch (error) {
        console.error("[picker] callback failed:", error);
      }
    };

    canvas.addEventListener("pointerdown", this.pointerDownHandler, true);
    canvas.addEventListener("pointermove", this.pointerMoveHandler);
    canvas.addEventListener("pointerup", this.pointerUpHandler, true);
    window.addEventListener("pointerup", this.pointerUpHandler, true);
  }

  private removePointerListeners() {
    const canvas = this.world.renderer?.three.domElement as HTMLCanvasElement | undefined;
    if (this.pointerDownHandler) {
      canvas?.removeEventListener("pointerdown", this.pointerDownHandler, true);
    }
    if (this.pointerMoveHandler) {
      canvas?.removeEventListener("pointermove", this.pointerMoveHandler);
    }
    if (this.pointerUpHandler) {
      canvas?.removeEventListener("pointerup", this.pointerUpHandler, true);
      window.removeEventListener("pointerup", this.pointerUpHandler, true);
    }
    this.pointerDownHandler = null;
    this.pointerMoveHandler = null;
    this.pointerUpHandler = null;
    this.downPos = null;
    this.pickCallback = null;
  }

  async highlightItemIds(itemIds: number[]) {
    if (!this.modelId) return;
    const fragments = this.components.get(OBC.FragmentsManager);
    const fragModel = fragments.list.get(this.modelId);

    await fragments.resetHighlight();
    if (fragModel) await fragModel.resetOpacity(undefined);

    if (itemIds.length === 0) {
      void fragments.core.update(true);
      return;
    }

    await fragments.highlight(
      {
        color: SELECTION_HIGHLIGHT_COLOR.clone(),
        opacity: 1,
        transparent: false,
        renderedFaces: 0,
      },
      { [this.modelId]: new Set(itemIds) },
    );
    void fragments.core.update(true);
  }

  async clearHighlight() {
    const fragments = this.components.get(OBC.FragmentsManager);
    await fragments.resetHighlight();
    if (this.modelId) {
      const fragModel = fragments.list.get(this.modelId);
      if (fragModel) await fragModel.resetOpacity(undefined);
    }
    void fragments.core.update(true);
  }

  async focusItemIds(itemIds: number[]) {
    if (itemIds.length === 0 || !this.modelId) return;
    const fragments = this.components.get(OBC.FragmentsManager);
    try {
      const boxes = await fragments.getBBoxes({ [this.modelId]: new Set(itemIds) });
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
    this.world.camera.controls?.setLookAt(18, 18, 18, 0, 0, 0, false);
  }

  fitAll() {
    if (this.disposed) return;
    if (!this.modelObject) return;
    this.applyPerspectiveClipPlanes(this.modelObject);
    const box = new THREE.Box3().setFromObject(this.modelObject);
    const center = box.getCenter(new THREE.Vector3());
    const ctrl = this.world.camera.controls;
    ctrl?.setOrbitPoint(center.x, center.y, center.z);
    ctrl?.setTarget(center.x, center.y, center.z, false);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
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
