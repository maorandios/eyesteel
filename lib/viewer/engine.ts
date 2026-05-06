"use client";

import * as THREE from "three";
import * as OBC from "@thatopen/components";
import type { ViewerMode } from "@/types/domain";
import { loadIfcModel } from "@/lib/viewer/ifc-loader";

interface PickHit {
  localId: number;
  itemId: number;
}

export class ViewerEngine {
  private readonly container: HTMLDivElement;
  private readonly components: OBC.Components;
  private world!: OBC.World;
  private animationHandle = 0;
  private modelObject: THREE.Object3D | null = null;
  private modelId: string | null = null;
  private disposed = false;

  private pointerDownHandler: ((event: PointerEvent) => void) | null = null;
  private pointerUpHandler: ((event: PointerEvent) => void) | null = null;
  private downPos: { x: number; y: number; t: number } | null = null;
  private pickCallback: ((hit: PickHit) => void) | null = null;

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
    this.world.camera.controls?.setLookAt(18, 18, 18, 0, 0, 0);

    const light = new THREE.HemisphereLight(0xffffff, 0x111827, 0.8);
    this.world.scene.three.add(light);

    this.installPointerListeners();
    this.animate();
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

    // Critical: the model's worker-side raycaster only loads tiles when a
    // camera is registered. Without this, fragments.raycast(...) always
    // returns null even though the geometry renders correctly.
    const cam = this.world.camera.three;
    if (cam && (cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
      casted.useCamera(cam as THREE.PerspectiveCamera);
    } else if (cam) {
      casted.useCamera(cam as THREE.OrthographicCamera);
    }

    // Drive worker→main mesh updates each frame so tiles refresh with the camera.
    const fragments = this.components.get(OBC.FragmentsManager);
    const cameraComp = this.world.camera as OBC.SimpleCamera;
    cameraComp.controls?.addEventListener("rest", () => {
      void fragments.core.update(true);
    });
    cameraComp.controls?.addEventListener("update", () => {
      void fragments.core.update();
    });
    void fragments.core.update(true);

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

    this.pointerDownHandler = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      this.downPos = { x: event.clientX, y: event.clientY, t: Date.now() };
      console.log("[picker] down", {
        x: event.clientX,
        y: event.clientY,
        target: (event.target as Element | null)?.tagName ?? null,
        type: event.pointerType,
      });
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
      console.log("[picker] up", {
        x: event.clientX,
        y: event.clientY,
        dx,
        dy,
        dt,
        isTap,
        target: (event.target as Element | null)?.tagName ?? null,
      });
      if (!isTap) return;
      if (!this.pickCallback) {
        console.log("[picker] skipped (no callback)");
        return;
      }

      const renderer = this.world.renderer;
      const camera = this.world.camera;
      if (!renderer?.three || !camera?.three) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const useX = event.clientX || start.x;
      const useY = event.clientY || start.y;
      const mouse = new THREE.Vector2(
        ((useX - rect.left) / rect.width) * 2 - 1,
        -((useY - rect.top) / rect.height) * 2 + 1,
      );
      let hit: { localId: number; itemId: number } | null = null;
      try {
        const pickers = this.components.get(OBC.FastModelPickers);
        const picker = pickers.get(this.world);
        const result = await picker.getItemAt(mouse);
        if (result && typeof result.localId === "number") {
          hit = { localId: result.localId, itemId: result.itemId };
        }
      } catch (error) {
        console.error("[picker] gpu pick failed:", error);
        return;
      }

      console.log("[picker] gpu pick", hit);
      if (!hit) return;
      try {
        this.pickCallback(hit);
      } catch (error) {
        console.error("[picker] callback failed:", error);
      }
    };

    // Listen on canvas (capture phase) AND on window so we never miss the
    // pointerup even if camera-controls captures the pointer mid-gesture.
    canvas.addEventListener("pointerdown", this.pointerDownHandler, true);
    canvas.addEventListener("pointerup", this.pointerUpHandler, true);
    window.addEventListener("pointerup", this.pointerUpHandler, true);
  }

  private removePointerListeners() {
    const canvas = this.world.renderer?.three?.domElement as HTMLCanvasElement | undefined;
    if (this.pointerDownHandler) {
      canvas?.removeEventListener("pointerdown", this.pointerDownHandler, true);
    }
    if (this.pointerUpHandler) {
      canvas?.removeEventListener("pointerup", this.pointerUpHandler, true);
      window.removeEventListener("pointerup", this.pointerUpHandler, true);
    }
    this.pointerDownHandler = null;
    this.pointerUpHandler = null;
    this.downPos = null;
    this.pickCallback = null;
  }

  async highlightItemIds(itemIds: number[]) {
    if (!this.modelId) return;
    const fragments = this.components.get(OBC.FragmentsManager);
    await fragments.resetHighlight();
    if (itemIds.length === 0) return;
    await fragments.highlight(
      {
        color: new THREE.Color("#fbbf24"),
        opacity: 1,
        transparent: false,
        renderedFaces: 0,
      },
      { [this.modelId]: new Set(itemIds) },
    );
  }

  async clearHighlight() {
    const fragments = this.components.get(OBC.FragmentsManager);
    await fragments.resetHighlight();
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
      this.world.camera.controls?.setLookAt(
        center.x + offset,
        center.y + offset,
        center.z + offset,
        center.x,
        center.y,
        center.z,
        true,
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
    this.modelObject.traverse((child) => {
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
    this.world.camera.controls?.setLookAt(18, 18, 18, 0, 0, 0, true);
  }

  fitAll() {
    if (this.disposed) return;
    if (!this.modelObject) return;
    const box = new THREE.Box3().setFromObject(this.modelObject);
    const center = box.getCenter(new THREE.Vector3());
    this.world.camera.controls?.setTarget(center.x, center.y, center.z, true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animationHandle);
    try {
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

  private animate = () => {
    this.animationHandle = requestAnimationFrame(this.animate);
  };
}
