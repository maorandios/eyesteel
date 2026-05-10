"use client";

import { Button } from "@/components/ui/button";

type Props = {
  visible: boolean;
  disabled?: boolean;
  onInspect: () => void;
};

/** Invites “בדוק חלק” when exactly one steel part is selected in the regular viewer. */
export function PartInspectionCallout({ visible, disabled, onInspect }: Props) {
  if (!visible) return null;

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 bottom-[5.5rem] z-[53] flex justify-center px-3 md:bottom-[4.25rem]"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      dir="rtl"
    >
      <div className="flex items-center gap-2 rounded-2xl border border-sky-700/80 bg-sky-950/95 px-3 py-2 shadow-xl backdrop-blur-sm">
        <span className="text-sm font-medium text-sky-50">בדיקת חלק זמינה</span>
        <Button
          type="button"
          variant="default"
          className="h-10 bg-sky-600 px-4 text-sm font-semibold hover:bg-sky-500"
          disabled={disabled}
          onClick={onInspect}
        >
          בדוק חלק
        </Button>
      </div>
    </div>
  );
}
