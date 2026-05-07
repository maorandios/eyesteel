/** Locale for visible digits — comma grouping (e.g. 1,234.56), used inside dir="ltr" spans. */
export const APP_NUMBER_LOCALE = "en-US";

const DISPLAY_EMPTY = "—";

function nf(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  return new Intl.NumberFormat(APP_NUMBER_LOCALE, opts);
}

/** Whole numbers with grouping (counts, quantities, IDs in labels). */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return DISPLAY_EMPTY;
  return nf({ maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(Math.round(value));
}

/** Fixed fractional digits with grouping. */
export function formatGroupedDecimal(
  value: number,
  minFractionDigits: number,
  maxFractionDigits: number,
): string {
  return nf({ minimumFractionDigits: minFractionDigits, maximumFractionDigits: maxFractionDigits }).format(
    value,
  );
}

/** Numeric kg — unit is in the column/header label. */
export function formatKgPlain(kg: number | null | undefined): string {
  if (kg == null || Number.isNaN(kg)) return DISPLAY_EMPTY;
  if (kg >= 100) return formatGroupedDecimal(kg, 0, 0);
  return formatGroupedDecimal(kg, 2, 2);
}

/** Numeric mm — unit is in the column/header label. */
export function formatMmPlain(mm: number | null | undefined): string {
  if (mm == null || Number.isNaN(mm)) return DISPLAY_EMPTY;
  return formatGroupedDecimal(mm, 2, 2);
}

/** Signed elevation in mm, two fractional digits. */
export function formatElevationMm(mm: number | null | undefined): string {
  if (mm == null || Number.isNaN(mm)) return DISPLAY_EMPTY;
  const absVal = Math.abs(mm);
  if (absVal < 1e-9) return "+0.00";
  const body = formatGroupedDecimal(absVal, 2, 2);
  const sign = mm > 0 ? "+" : "-";
  return `${sign}${body}`;
}

/** Quantities: integers grouped; otherwise decimals with grouping (up to 6 fraction digits). */
export function formatQuantityInt(q: number | null | undefined): string {
  if (q == null || Number.isNaN(q)) return DISPLAY_EMPTY;
  const rounded = Math.round(q);
  if (Math.abs(q - rounded) < 1e-6) return formatCount(rounded);
  return formatGroupedDecimal(q, 0, 6);
}
