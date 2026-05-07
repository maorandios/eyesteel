"use client";

import { cn } from "@/lib/utils";
import type { PropsWithChildren } from "react";

interface BottomSheetProps extends PropsWithChildren {
  open: boolean;
  title: string;
}

export function BottomSheet({ open, title, children }: BottomSheetProps) {
  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-0 z-30 rounded-t-3xl border border-zinc-700 bg-zinc-900/95 p-4 shadow-2xl transition-transform duration-200 safe-bottom",
        open ? "translate-y-0 touch-auto" : "pointer-events-none translate-y-[120%] touch-none",
      )}
    >
      <p className="mb-3 text-sm font-semibold text-zinc-200">{title}</p>
      {children}
    </div>
  );
}
