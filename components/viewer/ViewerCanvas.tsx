"use client";

import { useEffect, useRef } from "react";
import { ViewerEngine } from "@/lib/viewer/engine";

interface Props {
  onReady: (engine: ViewerEngine | null) => void;
}

export function ViewerCanvas({ onReady }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const engine = new ViewerEngine(ref.current);
    onReady(engine);
    return () => {
      onReady(null);
      engine.dispose();
    };
  }, [onReady]);

  return <div ref={ref} className="h-full w-full touch-none" />;
}
