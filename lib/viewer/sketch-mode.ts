import * as THREE from "three";

export const SKETCH_EDGE_CHILD_NAME = "eyeSteel-sketch-edges";

/** Dark gray CAD-style strokes (only visible tint in sketch mode — solids are transparent). */
export const SKETCH_EDGE_HEX = 0x2c2c2c;

/** Fewer segments on curved steel for tablet FPS (degrees). */
export const SKETCH_EDGE_THRESHOLD_DEG = 34;

/** Faces invisible; outlines carry the sketch — keeps scene backdrop + lighting unchanged. */
export function createSketchFillMaterial(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
  });
}

export function createSketchLineMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: SKETCH_EDGE_HEX,
    toneMapped: false,
  });
}

/** That Open fragment tiles use {@link LodMaterial} — opacity lives on uniforms, not mesh.material swaps. */
export function isLodFragmentMaterial(m: THREE.Material): boolean {
  return Boolean((m as THREE.Material & { isLodMaterial?: boolean }).isLodMaterial);
}

/** Remove cached edge LineSegments from meshes under `root` and dispose their geometries. */
export function stripSketchEdgeChildren(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const removeList: THREE.Object3D[] = [];
    for (const ch of mesh.children) {
      if (ch.name === SKETCH_EDGE_CHILD_NAME) removeList.push(ch);
    }
    for (const ch of removeList) {
      mesh.remove(ch);
      const ls = ch as THREE.LineSegments;
      ls.geometry?.dispose();
    }
  });
}

/**
 * One-time: add LineSegments (EdgesGeometry) under each mesh so transforms stay in sync — no per-frame updates.
 */
export function attachSketchEdges(
  root: THREE.Object3D,
  lineMaterial: THREE.LineBasicMaterial,
  thresholdRad = THREE.MathUtils.degToRad(SKETCH_EDGE_THRESHOLD_DEG),
): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh & THREE.InstancedMesh;
    if (!mesh.isMesh || mesh.isInstancedMesh) return;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom || !geom.attributes.position) return;
    if (geom.getAttribute("position").count < 3) return;

    try {
      const edgesGeom = new THREE.EdgesGeometry(geom, thresholdRad);
      const lines = new THREE.LineSegments(edgesGeom, lineMaterial);
      lines.name = SKETCH_EDGE_CHILD_NAME;
      lines.raycast = () => {};
      lines.visible = false;
      lines.frustumCulled = mesh.frustumCulled;
      mesh.add(lines);
    } catch {
      try {
        const wireGeom = new THREE.WireframeGeometry(geom);
        const lines = new THREE.LineSegments(wireGeom, lineMaterial);
        lines.name = SKETCH_EDGE_CHILD_NAME;
        lines.raycast = () => {};
        lines.visible = false;
        lines.frustumCulled = mesh.frustumCulled;
        mesh.add(lines);
      } catch {
        /* degenerate / exotic buffers */
      }
    }
  });
}
