"use client";

import type { DimensionLine } from "@thatopen/components-front";
import * as THREE from "three";

/** Hebrew abbreviation for millimetres (מ״מ). */
const MM_UNIT_HE = "מ\u05F4מ";

/** Matches measurement line material `#404040` / `0x404040`. */
const BADGE_BG_GRAY = "#404040";

/** Screen-space endpoint markers (same gray as line/badge). */
const ENDPOINT_DOT_SIZE_PX = 10;

type LineOverlayDom = {
  badge: HTMLDivElement;
  startDot: HTMLDivElement;
  endDot: HTMLDivElement;
};

function createEndpointDotElement(): HTMLDivElement {
  const el = document.createElement("div");
  el.setAttribute("data-eyeSteel-measure-endpoint", "true");
  el.style.cssText =
    `position:absolute;width:${ENDPOINT_DOT_SIZE_PX}px;height:${ENDPOINT_DOT_SIZE_PX}px;` +
    `border-radius:50%;background:${BADGE_BG_GRAY};transform:translate(-50%,-50%);` +
    `box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none;z-index:46;`;
  return el;
}

type Css2dMarkLike = {
  visible: boolean;
  three: { element: unknown };
};

/** Hide That Open CSS2D labels/endpoints so only our HTML badges + 3D line remain. */
export function hideThatOpenDimensionCss2d(dim: DimensionLine): void {
  dim.label.visible = false;
  const labEl = dim.label.three.element;
  if (labEl instanceof HTMLElement) {
    labEl.style.display = "none";
    labEl.style.visibility = "hidden";
    labEl.style.opacity = "0";
    labEl.style.pointerEvents = "none";
  }

  const endpoints = (dim as unknown as { _endpoints?: Iterable<Css2dMarkLike> })._endpoints;
  if (endpoints) {
    for (const ep of endpoints) {
      ep.visible = false;
      const el = ep.three.element;
      if (el instanceof HTMLElement) {
        el.style.display = "none";
        el.style.visibility = "hidden";
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
      }
    }
  }

  for (const child of dim.rectangleDimensions) hideThatOpenDimensionCss2d(child);
  for (const child of dim.projectionDimensions) hideThatOpenDimensionCss2d(child);
}

/**
 * Screen-space HTML badges for length measurements. Avoids That Open's CSS2D labels,
 * which can desync from the WebGL canvas on some viewer setups.
 */
export class MeasurementHtmlOverlay {
  private readonly layer: HTMLDivElement;
  private readonly byLineId = new Map<string, LineOverlayDom>();

  constructor(host: HTMLElement) {
    const style = typeof getComputedStyle !== "undefined" ? getComputedStyle(host) : null;
    if (!style || style.position === "static") {
      host.style.position = "relative";
    }
    this.layer = document.createElement("div");
    this.layer.setAttribute("data-eyeSteel-measure-labels", "true");
    this.layer.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:45;overflow:hidden;";
    host.appendChild(this.layer);
  }

  dispose() {
    this.clearDom();
    this.layer.remove();
  }

  clearDom() {
    for (const row of this.byLineId.values()) {
      row.badge.remove();
      row.startDot.remove();
      row.endDot.remove();
    }
    this.byLineId.clear();
  }

  /** Scene distances follow That Open metres → always show whole millimetres for the badge. */
  private static setBadgeMillimetresHe(badge: HTMLDivElement, meters: number) {
    const mm = meters * 1000;
    const digits = Number.isFinite(mm) ? Math.round(mm).toString() : "0";

    let unit = badge.children[0] as HTMLSpanElement | undefined;
    let num = badge.children[1] as HTMLSpanElement | undefined;
    if (!unit || !num) {
      badge.replaceChildren();
      unit = document.createElement("span");
      unit.dir = "rtl";
      unit.textContent = MM_UNIT_HE;
      num = document.createElement("span");
      num.dir = "ltr";
      badge.appendChild(unit);
      badge.appendChild(num);
    }
    num.textContent = digits;
  }

  /** Same NDC → overlay pixels as badges; `scratch` receives projected xyz. */
  private static overlayPixelForWorldPoint(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    world: THREE.Vector3,
    scratch: THREE.Vector3,
  ): { x: number; y: number; visible: boolean } {
    scratch.copy(world).project(camera);
    const ox = canvas.offsetLeft;
    const oy = canvas.offsetTop;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const x = ox + (scratch.x * 0.5 + 0.5) * cw;
    const y = oy + (-scratch.y * 0.5 + 0.5) * ch;
    const margin = 40;
    const visible =
      scratch.z > -1 &&
      scratch.z < 1 &&
      x >= ox - margin &&
      x <= ox + cw + margin &&
      y >= oy - margin &&
      y <= oy + ch + margin;
    return { x, y, visible };
  }

  /**
   * Place/update badges from live LengthMeasurement dimension lines.
   */
  sync(lines: Iterable<DimensionLine>, camera: THREE.Camera, canvas: HTMLCanvasElement) {
    const next = new Set<string>();
    const scratch = new THREE.Vector3();

    for (const dim of lines) {
      const line = dim.line;
      const id = line.id;
      next.add(id);

      hideThatOpenDimensionCss2d(dim);

      let row = this.byLineId.get(id);
      if (!row) {
        const startDot = createEndpointDotElement();
        const endDot = createEndpointDotElement();
        const badge = document.createElement("div");
        badge.style.cssText =
          `position:absolute;transform:translate(-50%,-50%);display:inline-flex;flex-direction:row;direction:ltr;align-items:center;gap:4px;padding:6px 10px;border-radius:8px;font-size:14px;font-weight:600;color:white;background:${BADGE_BG_GRAY};box-shadow:0 2px 10px rgba(0,0,0,.28);white-space:nowrap;z-index:47;pointer-events:none;`;
        this.layer.appendChild(startDot);
        this.layer.appendChild(endDot);
        this.layer.appendChild(badge);
        row = { badge, startDot, endDot };
        this.byLineId.set(id, row);
      }

      const mid = new THREE.Vector3().addVectors(line.start, line.end).multiplyScalar(0.5);
      const midPx = MeasurementHtmlOverlay.overlayPixelForWorldPoint(canvas, camera, mid, scratch);

      if (!midPx.visible) {
        row.badge.style.display = "none";
      } else {
        row.badge.style.display = "inline-flex";
        row.badge.style.left = `${midPx.x}px`;
        row.badge.style.top = `${midPx.y}px`;
        MeasurementHtmlOverlay.setBadgeMillimetresHe(row.badge, line.distance());
      }

      const startPx = MeasurementHtmlOverlay.overlayPixelForWorldPoint(
        canvas,
        camera,
        line.start,
        scratch,
      );
      if (!startPx.visible) {
        row.startDot.style.display = "none";
      } else {
        row.startDot.style.display = "block";
        row.startDot.style.left = `${startPx.x}px`;
        row.startDot.style.top = `${startPx.y}px`;
      }

      const endPx = MeasurementHtmlOverlay.overlayPixelForWorldPoint(canvas, camera, line.end, scratch);
      if (!endPx.visible) {
        row.endDot.style.display = "none";
      } else {
        row.endDot.style.display = "block";
        row.endDot.style.left = `${endPx.x}px`;
        row.endDot.style.top = `${endPx.y}px`;
      }
    }

    for (const id of [...this.byLineId.keys()]) {
      if (!next.has(id)) {
        const row = this.byLineId.get(id);
        if (row) {
          row.badge.remove();
          row.startDot.remove();
          row.endDot.remove();
        }
        this.byLineId.delete(id);
      }
    }
  }
}
