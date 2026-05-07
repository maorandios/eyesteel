"use client";

import * as THREE from "three";

/** Hebrew abbreviation for millimetres (מ״מ). */
const MM_UNIT_HE = "מ\u05F4מ";

function formatMm(meters: number): string {
  const mm = meters * 1000;
  return Number.isFinite(mm) ? Math.round(mm).toLocaleString("he-IL") : "—";
}

function badgeStyle(bg: string): string {
  return (
    `position:absolute;transform:translate(-50%,-50%);display:inline-flex;flex-direction:row;` +
    `direction:ltr;align-items:center;gap:4px;padding:5px 9px;border-radius:8px;font-size:12px;` +
    `font-weight:600;color:white;background:${bg};box-shadow:0 2px 8px rgba(0,0,0,.28);` +
    `white-space:nowrap;z-index:48;pointer-events:none;`
  );
}

/** Screen‑space snap cursor + dimension badges for smart measure. */
export class SmartMeasureOverlay {
  private readonly layer: HTMLDivElement;
  private snapEl: HTMLDivElement | null = null;
  private readonly badges = new Map<string, HTMLDivElement>();

  constructor(host: HTMLElement) {
    if (typeof getComputedStyle !== "undefined" && getComputedStyle(host).position === "static") {
      host.style.position = "relative";
    }
    this.layer = document.createElement("div");
    this.layer.setAttribute("data-eyeSteel-smart-measure-overlay", "true");
    this.layer.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:45;overflow:hidden;";
    host.appendChild(this.layer);
  }

  dispose() {
    this.clearBadges();
    this.hideSnap();
    this.layer.remove();
  }

  clearBadges() {
    for (const el of this.badges.values()) el.remove();
    this.badges.clear();
  }

  hideSnap() {
    if (this.snapEl) {
      this.snapEl.remove();
      this.snapEl = null;
    }
  }

  setSnapMarker(canvas: HTMLCanvasElement, camera: THREE.Camera, world: THREE.Vector3 | null) {
    this.hideSnap();
    if (!world) return;
    const scratch = new THREE.Vector3();
    const px = project(world, camera, canvas, scratch);
    if (!px.visible) return;
    const el = document.createElement("div");
    el.setAttribute("data-eyeSteel-snap-marker", "true");
    el.style.cssText =
      `position:absolute;left:${px.x}px;top:${px.y}px;width:14px;height:14px;border-radius:50%;` +
      `border:2px solid #f59e0b;background:rgba(245,158,11,.25);transform:translate(-50%,-50%);` +
      `box-shadow:0 0 0 1px rgba(0,0,0,.35);z-index:49;pointer-events:none;`;
    this.layer.appendChild(el);
    this.snapEl = el;
  }

  syncDimensionBadges(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    specs: Array<{ id: string; world: THREE.Vector3; meters: number; variant: "main" | "break" }>,
  ) {
    const scratch = new THREE.Vector3();
    const keep = new Set<string>();

    for (const s of specs) {
      keep.add(s.id);
      let el = this.badges.get(s.id);
      if (!el) {
        el = document.createElement("div");
        el.dir = "rtl";
        this.badges.set(s.id, el);
        this.layer.appendChild(el);
      }
      const bg = s.variant === "main" ? "#404040" : "#5c6b7c";
      el.style.cssText = badgeStyle(bg);
      el.innerHTML = `<span>${MM_UNIT_HE}</span><span dir="ltr">${formatMm(s.meters)}</span>`;

      const px = project(s.world, camera, canvas, scratch);
      if (!px.visible) {
        el.style.display = "none";
      } else {
        el.style.display = "inline-flex";
        el.style.left = `${px.x}px`;
        el.style.top = `${px.y}px`;
      }
    }

    for (const id of [...this.badges.keys()]) {
      if (!keep.has(id)) {
        this.badges.get(id)?.remove();
        this.badges.delete(id);
      }
    }
  }

  clearDom() {
    this.clearBadges();
    this.hideSnap();
  }
}

function project(
  world: THREE.Vector3,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  scratch: THREE.Vector3,
): { x: number; y: number; visible: boolean } {
  scratch.copy(world).project(camera);
  const ox = canvas.offsetLeft;
  const oy = canvas.offsetTop;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const x = ox + (scratch.x * 0.5 + 0.5) * cw;
  const y = oy + (-scratch.y * 0.5 + 0.5) * ch;
  const margin = 48;
  const visible =
    scratch.z > -1 &&
    scratch.z < 1 &&
    x >= ox - margin &&
    x <= ox + cw + margin &&
    y >= oy - margin &&
    y <= oy + ch + margin;
  return { x, y, visible };
}
