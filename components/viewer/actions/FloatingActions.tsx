"use client";

import { Ruler, Search, Layers3, RotateCcw, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { he } from "@/lib/i18n/he";

interface Props {
  onSearch: () => void;
  onLayers: () => void;
  onResetView: () => void;
  onFitAll: () => void;
  measurementActive?: boolean;
  onMeasurementToggle?: () => void;
}

export function FloatingActions({
  onSearch,
  onLayers,
  onResetView,
  onFitAll,
  measurementActive = false,
  onMeasurementToggle,
}: Props) {
  return (
    <div className="absolute bottom-36 left-3 z-50 flex flex-col gap-2">
      <Button
        type="button"
        size="lg"
        variant={measurementActive ? "default" : "secondary"}
        className="min-h-14 gap-2 px-4 text-base font-semibold shadow-lg"
        onClick={onMeasurementToggle}
        aria-label="מדידה"
        aria-pressed={measurementActive}
      >
        <Ruler size={22} />
        מדידה
      </Button>
      <Button size="icon" variant="secondary" onClick={onSearch} aria-label={he.search}>
        <Search size={20} />
      </Button>
      <Button size="icon" variant="secondary" onClick={onLayers} aria-label={he.layers}>
        <Layers3 size={20} />
      </Button>
      <Button size="icon" variant="secondary" onClick={onResetView} aria-label={he.resetView}>
        <RotateCcw size={20} />
      </Button>
      <Button size="icon" variant="secondary" onClick={onFitAll} aria-label={he.fitAll}>
        <ScanSearch size={20} />
      </Button>
    </div>
  );
}
