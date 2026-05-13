"use client";

import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const dockSubLabelClass =
  "max-w-[3.25rem] text-center text-[8px] font-medium leading-tight tracking-tight text-zinc-600 sm:max-w-[3.5rem] sm:text-[9px]";

const dockSubmenuActiveIcon = "[&_svg]:!text-[#003CFF]";

/** Smaller secondary rail: border / blur / pill matching the main contextual pickers. */
export function DockSubmenuBar({
  children,
  className,
  ...rest
}: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "pointer-events-auto flex flex-nowrap items-center justify-center gap-x-0 overflow-visible rounded-full border border-zinc-300/80 bg-[#e8ecef]/95 px-1 py-1 shadow-2xl backdrop-blur-md sm:gap-x-px sm:px-1.5 sm:py-1.5",
        className,
      )}
      dir="rtl"
      {...rest}
    >
      {children}
    </div>
  );
}

export function DockSubmenuPill({
  label,
  labelClassName,
  children,
  selected,
  className,
  ...props
}: {
  label: string;
  /** Merged after {@link dockSubLabelClass} for wider / denser captions. */
  labelClassName?: string;
  children: ReactNode;
  selected?: boolean;
} & ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="default"
      className={cn(
        "h-auto min-h-0 w-[3.35rem] shrink-0 flex-col gap-1.5 rounded-full border-0 bg-transparent px-0.5 py-1 font-normal tracking-normal text-zinc-700 shadow-none ring-0 outline-none sm:w-[3.75rem] sm:gap-2 sm:py-1.5",
        "disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0 [&_svg]:text-zinc-700",
        "focus-visible:ring-2 focus-visible:ring-zinc-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-[#e8ecef]",
        selected
          ? "cursor-default bg-transparent hover:bg-transparent active:scale-100 hover:outline-none focus-visible:bg-transparent"
          : "hover:bg-zinc-200/80 hover:text-zinc-950 hover:outline-none active:scale-[0.99]",
        className,
      )}
      aria-pressed={selected}
      {...props}
    >
      <span
        className={cn(
          "flex min-h-[1.1rem] items-center justify-center text-zinc-700 [&_svg]:size-[1.05rem] sm:[&_svg]:size-[1.15rem]",
          selected && dockSubmenuActiveIcon,
        )}
      >
        {children}
      </span>
      <span className={cn(dockSubLabelClass, labelClassName)}>{label}</span>
    </Button>
  );
}

/** Dot separator between groups inside {@link DockSubmenuBar}. */
export function DockSubmenuDotSep() {
  return <span className="mx-px h-1 w-1 shrink-0 rounded-full bg-zinc-400/80 sm:mx-0.5" aria-hidden />;
}
