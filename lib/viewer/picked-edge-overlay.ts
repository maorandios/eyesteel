import * as THREE from "three";
import type { FragmentsModel, MeshData } from "@thatopen/fragments";
import {
  SKETCH_EDGE_THRESHOLD_DEG,
  getOrCreateSketchEdgeLineMaterial,
  isLodFragmentMaterial,
} from "@/lib/viewer/sketch-mode";

/**
 * Top-level overlay group attached under `model.object`, holding `LineSegments` for the picked
 * element(s) at full opacity. Context mode keeps main-view sketch edges at ghost opacity while this overlay
 * draws on top, giving the user crisp picked outlines without affecting other items in the same
 * worker tile.
 */
export const PICKED_EDGE_OVERLAY_NAME = "eyeSteel-picked-edge-overlay";

/** Same geometry pipeline as {@link PICKED_EDGE_OVERLAY_NAME}, used for סינון תצוגה remainder edges. */
export const VIEW_FILTER_EDGE_OVERLAY_NAME = "eyeSteel-view-filter-edge-overlay";

const FALLBACK_EDGE_COLOR = new THREE.Color(0x9ca3af);

const GEOM_BATCH = 48;

/**
 * Worker uses LOD `CurrentLod.GEOMETRY = 0` to return real per-item index/position buffers
 * (instead of LOD billboards). We pin `0` here to avoid pulling the enum at runtime.
 */
const FRAGMENTS_LOD_GEOMETRY: 0 = 0;

type LodLikeMaterial = THREE.ShaderMaterial & { lodColor: THREE.Color };

/**
 * Read the actual face color the GPU is using for this tile mesh. LOD tiles (default) carry it on
 * the {@link LodLikeMaterial} `lodColor` uniform; CONTEXT mode flips tiles to `LodMode.ALL_VISIBLE`
 * shell meshes which use {@link THREE.MeshStandardMaterial}/Lambert/Phong with `material.color`.
 * Either way we want the color the **renderer** is drawing the face with — never an IFC-side
 * material definition (those can drift from what's actually displayed; see
 * `getItemsMaterialDefinition` upstream `// TODO: Fix, this is wrong`).
 */
function readMeshFaceColor(mesh: THREE.Mesh): THREE.Color | null {
  const mats = mesh.material;
  const m0 = Array.isArray(mats) ? mats[0] : mats;
  if (!m0) return null;
  if (isLodFragmentMaterial(m0)) {
    return (m0 as LodLikeMaterial).lodColor.clone();
  }
  if (
    m0 instanceof THREE.MeshStandardMaterial ||
    m0 instanceof THREE.MeshLambertMaterial ||
    m0 instanceof THREE.MeshPhongMaterial ||
    m0 instanceof THREE.MeshBasicMaterial
  ) {
    return m0.color.clone();
  }
  const c = (m0 as { color?: unknown }).color;
  if (c instanceof THREE.Color) return c.clone();
  return null;
}

/**
 * Walk the scene once to build `tileId → tile mesh`. Tiles register themselves with `tileId` in
 * `userData` on creation (see `MeshManager.handleTileRequest` in the fragments lib). We skip the
 * picked-edge overlay group itself so we never resolve to our own children.
 */
function buildTileMeshIndex(modelRoot: THREE.Object3D): Map<number, THREE.Mesh> {
  const out = new Map<number, THREE.Mesh>();
  modelRoot.traverse((obj) => {
    if (obj.name === PICKED_EDGE_OVERLAY_NAME || obj.name === VIEW_FILTER_EDGE_OVERLAY_NAME) return;
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const tileId = (mesh.userData as Record<string, unknown>).tileId;
    if (typeof tileId !== "number") return;
    if (!out.has(tileId)) out.set(tileId, mesh);
  });
  return out;
}

/**
 * Per-item face color sourced from the **live tile mesh** the picked item draws into — this is the
 * exact same color the regular main-view sketch edges read from (see
 * `c.lodColor.copy(edgeLineColorFromFace(source.lodColor))` in `sketch-mode.ts`), which is why
 * those edges always match the face perfectly. Picking the same source here is what guarantees
 * the picked overlay matches.
 *
 * Works in both isolation modes:
 * - **בודד** (isolated): tiles stay as `LodMaterial`; `setVisible(toHide, false)` only flips
 *   `itemFilter`, leaving `lodColor` untouched.
 * - **הצג בהקשר** (context): `LodMode.ALL_VISIBLE` flips tiles to shell meshes with regular
 *   `MeshStandard/Lambert/Phong` materials → reads `material.color`.
 */
async function resolveFaceColorsByTileMesh(
  fragModel: FragmentsModel,
  modelRoot: THREE.Object3D,
  pickedLocalIds: number[],
): Promise<Map<number, THREE.Color>> {
  const out = new Map<number, THREE.Color>();
  if (pickedLocalIds.length === 0) return out;
  const tileToMesh = buildTileMeshIndex(modelRoot);
  await Promise.all(
    pickedLocalIds.map(async (lid) => {
      try {
        const chunks = await fragModel.getItemDrawChunks([lid]);
        for (const c of chunks) {
          const mesh = tileToMesh.get(c.tileId);
          if (!mesh) continue;
          const col = readMeshFaceColor(mesh);
          if (col) {
            out.set(lid, col);
            return;
          }
        }
      } catch {
        /* swallow; caller falls back to material definition / grey */
      }
    }),
  );
  return out;
}

/**
 * `getItemsMaterialDefinition` returns the MaterialDefinition with `color: THREE.Color`, but the
 * value originates in the fragments worker where it crosses a `postMessage` boundary. Structured
 * clone strips prototypes, so on the main thread we may receive either a real `THREE.Color` (when
 * the worker / lib has run `resetColors`) or a plain `{ r, g, b }` POJO. Accept both.
 */
function coerceMaterialDefinitionColor(c: unknown): THREE.Color | null {
  if (c instanceof THREE.Color) return c.clone();
  if (typeof c !== "object" || c === null) return null;
  const o = c as { r?: unknown; g?: unknown; b?: unknown; isColor?: unknown };
  if (typeof o.r !== "number" || typeof o.g !== "number" || typeof o.b !== "number") return null;
  return new THREE.Color(o.r, o.g, o.b);
}

/**
 * Backup color source — `FragmentsModel.getItemsMaterialDefinition` per-item IFC tint. Used only
 * when the live tile mesh isn't reachable (e.g. tile not yet streamed in). The upstream lib has a
 * known `// TODO: Fix, this is wrong` on this API, so we never use it as the primary path: it can
 * disagree with what the renderer actually draws.
 */
async function resolveFaceColorsByMaterialDefinition(
  fragModel: FragmentsModel,
  pickedLocalIds: number[],
): Promise<Map<number, THREE.Color>> {
  const out = new Map<number, THREE.Color>();
  if (pickedLocalIds.length === 0) return out;
  try {
    const blocks = await fragModel.getItemsMaterialDefinition(pickedLocalIds);
    for (const b of blocks) {
      const col = coerceMaterialDefinitionColor(b.definition.color);
      if (!col) continue;
      for (const lid of b.localIds) {
        if (!out.has(lid)) out.set(lid, col.clone());
      }
    }
  } catch {
    /* leave map empty; caller will fall back */
  }
  return out;
}

/**
 * Resolve per-localId edge face color. Primary source is the host tile mesh's live face color —
 * the exact same source the regular main-view sketch edges use, so the picked overlay reads
 * pixel-identical to what the user sees on the face. Secondary is `getItemsMaterialDefinition`
 * (covers the rare case where the tile isn't streamed in yet). Last resort: grey, so we always
 * return a usable color.
 */
async function resolvePickedFaceColors(
  fragModel: FragmentsModel,
  modelRoot: THREE.Object3D,
  pickedLocalIds: number[],
): Promise<Map<number, THREE.Color>> {
  const primary = await resolveFaceColorsByTileMesh(fragModel, modelRoot, pickedLocalIds);
  const missing = pickedLocalIds.filter((lid) => !primary.has(lid));
  const secondary =
    missing.length > 0
      ? await resolveFaceColorsByMaterialDefinition(fragModel, missing)
      : new Map<number, THREE.Color>();

  const out = new Map<number, THREE.Color>();
  for (const lid of pickedLocalIds) {
    out.set(
      lid,
      primary.get(lid) ?? secondary.get(lid) ?? FALLBACK_EDGE_COLOR.clone(),
    );
  }
  return out;
}

function toUint32IndexArray(raw: NonNullable<MeshData["indices"]>): Uint32Array {
  if (raw instanceof Uint32Array) return raw;
  const out = new Uint32Array(raw.length);
  out.set(raw);
  return out;
}

function meshDataToBufferGeometry(mesh: MeshData): THREE.BufferGeometry | null {
  if (!mesh.positions || mesh.positions.length < 9) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(Float32Array.from(mesh.positions), 3),
  );
  if (mesh.indices && mesh.indices.length >= 3) {
    geom.setIndex(new THREE.BufferAttribute(toUint32IndexArray(mesh.indices), 1));
  }
  if (mesh.transform) geom.applyMatrix4(mesh.transform);
  geom.computeBoundingSphere();
  return geom;
}

/**
 * Build a `THREE.Group` of full-opacity `LineSegments` covering only the supplied picked items.
 * Geometries come from `fragModel.getItemsGeometry(..., CurrentLod.GEOMETRY)` so they reflect the
 * actual per-element shape (independent of how the worker batches items into tiles). Edge color
 * matches the host tile's live `lodColor` darkened by `getOrCreateSketchEdgeLineMaterial`, which
 * is the exact same color rule the regular main-view sketch edges use — so the overlay blends
 * with the dimmed background without a "gray fallback".
 */
export type BuildPickedEdgeOverlayOptions = {
  /** Yield between worker geometry batches so large “show everyone except hidden” passes stay responsive. */
  yieldBetweenBatches?: boolean;
  /** Root group name (default {@link PICKED_EDGE_OVERLAY_NAME}). */
  groupName?: string;
};

export async function buildPickedEdgeOverlay(
  fragModel: FragmentsModel,
  modelRoot: THREE.Object3D,
  pickedLocalIds: readonly number[],
  lineMaterialPool: Map<number, THREE.LineBasicMaterial>,
  options?: BuildPickedEdgeOverlayOptions,
): Promise<THREE.Group> {
  const group = new THREE.Group();
  const rootName = options?.groupName ?? PICKED_EDGE_OVERLAY_NAME;
  group.name = rootName;
  const ids = [...new Set(pickedLocalIds)].filter((n) => Number.isFinite(n));
  if (ids.length === 0) return group;

  const colorByLocal = await resolvePickedFaceColors(fragModel, modelRoot, ids);
  const threshold = THREE.MathUtils.degToRad(SKETCH_EDGE_THRESHOLD_DEG);
  const yieldBetween = options?.yieldBetweenBatches === true;

  for (let i = 0; i < ids.length; i += GEOM_BATCH) {
    const slice = ids.slice(i, i + GEOM_BATCH);
    let itemGeoms: MeshData[][];
    try {
      itemGeoms = await fragModel.getItemsGeometry(slice, FRAGMENTS_LOD_GEOMETRY);
    } catch {
      continue;
    }

    for (let j = 0; j < slice.length; j++) {
      const localId = slice[j];
      const chunks = itemGeoms[j];
      if (!chunks?.length) continue;

      const face = colorByLocal.get(localId) ?? FALLBACK_EDGE_COLOR;
      const lineMat = getOrCreateSketchEdgeLineMaterial(lineMaterialPool, face);

      for (const md of chunks) {
        const g = meshDataToBufferGeometry(md);
        if (!g) continue;
        let edgesGeom: THREE.EdgesGeometry | THREE.WireframeGeometry;
        try {
          edgesGeom = new THREE.EdgesGeometry(g, threshold);
        } catch {
          try {
            edgesGeom = new THREE.WireframeGeometry(g);
          } catch {
            g.dispose();
            continue;
          }
        }
        g.dispose();
        const lines = new THREE.LineSegments(edgesGeom, lineMat);
        lines.name = `${rootName}-line`;
        lines.raycast = () => {};
        lines.frustumCulled = true;
        /** Above the dimmed main-view edges (renderOrder 1) and ghost faces (renderOrder -10). */
        lines.renderOrder = 2;
        group.add(lines);
      }
    }
    if (yieldBetween && i + GEOM_BATCH < ids.length) {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  }

  return group;
}

/** Dispose line geometries built for an overlay group that was never attached (abort / stale-generation). */
export function disposeConstructedEdgeOverlayGroup(group: THREE.Group | null): void {
  if (!group) return;
  group.traverse((obj) => {
    const ls = obj as THREE.LineSegments;
    if ((ls as THREE.Object3D).type === "LineSegments" && ls.geometry) ls.geometry.dispose();
  });
}

/** Remove the overlay group from its parent and dispose its line geometries. Materials are pooled. */
export function disposePickedEdgeOverlay(group: THREE.Group | null): void {
  if (!group) return;
  group.parent?.remove(group);
  group.traverse((obj) => {
    const ls = obj as THREE.LineSegments;
    if ((ls as THREE.Object3D).type === "LineSegments") ls.geometry?.dispose();
  });
}
