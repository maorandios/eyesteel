"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Pt = { x: number; y: number };

type Stroke = { id: string; pts: Pt[] };

const MARKUP_STROKE = "#ef4444";
/** Uniform screen‑px width (SVG viewBox stretch made H/V lines different thickness). */
const LINE_WIDTH_PX = 3;

function newStrokeId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `markup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function drawStrokesOnCanvas(
  canvas: HTMLCanvasElement,
  wrapW: number,
  wrapH: number,
  list: Stroke[],
) {
  const ctx = canvas.getContext("2d");
  if (!ctx || wrapW <= 0 || wrapH <= 0) return;

  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const bw = Math.max(1, Math.round(wrapW * dpr));
  const bh = Math.max(1, Math.round(wrapH * dpr));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = `${wrapW}px`;
  canvas.style.height = `${wrapH}px`;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bw, bh);
  ctx.scale(dpr, dpr);

  ctx.strokeStyle = MARKUP_STROKE;
  ctx.fillStyle = MARKUP_STROKE;
  ctx.lineWidth = LINE_WIDTH_PX;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const s of list) {
    const pts = s.pts;
    if (pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x * wrapW, pts[0].y * wrapH);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x * wrapW, pts[i].y * wrapH);
      }
      ctx.stroke();
    } else if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x * wrapW, pts[0].y * wrapH, LINE_WIDTH_PX * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** Normalized overlay on the viewport; strokes kept when mode is off (pointer-events-none). */
export function DrawingMarkupLayer({
  active,
  clearSignal,
  onInkPresenceChange,
}: {
  active: boolean;
  /** Increments when user taps נקה — clears all ink. */
  clearSignal: number;
  onInkPresenceChange?: (hasInk: boolean) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [current, setCurrent] = useState<Stroke | null>(null);
  const drawingRef = useRef(false);

  /** Dedupes finalize when pointer‑up races with ציור off (effect + flush). */
  const committedDraftIdsRef = useRef<Set<string>>(new Set());

  const flushStroke = useCallback(() => {
    drawingRef.current = false;
    setCurrent((prev) => {
      if (!prev?.pts.length) return null;
      if (committedDraftIdsRef.current.has(prev.id)) return null;
      committedDraftIdsRef.current.add(prev.id);
      setStrokes((s) => [...s, prev]);
      return null;
    });
  }, []);

  useEffect(() => {
    if (clearSignal <= 0) return;
    setStrokes([]);
    setCurrent(null);
    drawingRef.current = false;
    committedDraftIdsRef.current.clear();
  }, [clearSignal]);

  /** One code path for finishing ink (pointer up / cancel / leaving ציור). */
  useEffect(() => {
    if (active) return;
    drawingRef.current = false;
    flushStroke();
  }, [active, flushStroke]);

  const toPt = useCallback((e: React.PointerEvent): Pt | null => {
    const el = wrapRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  }, []);

  const redrawCanvas = useCallback(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const list: Stroke[] =
      current && current.pts.length > 0 ? [...strokes, current] : strokes;
    drawStrokesOnCanvas(canvas, w, h, list);
  }, [strokes, current]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      redrawCanvas();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [redrawCanvas]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return;
    e.preventDefault();
    const p = toPt(e);
    if (!p) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
    drawingRef.current = true;
    setCurrent({ id: newStrokeId(), pts: [p] });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active || !drawingRef.current) return;
    e.preventDefault();
    const p = toPt(e);
    if (!p) return;
    setCurrent((prev) =>
      prev && prev.pts.length ? { ...prev, pts: [...prev.pts, p] } : { id: newStrokeId(), pts: [p] },
    );
  };

  const onPointerStop = (e: React.PointerEvent<HTMLDivElement>) => {
    flushStroke();
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* noop */
    }
  };

  const rendered: Stroke[] =
    current && current.pts.length > 0 ? [...strokes, current] : strokes;

  useEffect(() => {
    onInkPresenceChange?.(rendered.length > 0);
  }, [rendered.length, onInkPresenceChange]);

  return (
    <div
      ref={wrapRef}
      className={cn(
        "absolute inset-0 z-[25] touch-none select-none",
        active ? "pointer-events-auto cursor-crosshair" : "pointer-events-none",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerStop}
      onPointerCancel={onPointerStop}
      onPointerLeave={(e) => {
        if (!active || !drawingRef.current) return;
        if (e.buttons === 0) onPointerStop(e);
      }}
    >
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 block h-full w-full"
        aria-hidden
      />
    </div>
  );
}
