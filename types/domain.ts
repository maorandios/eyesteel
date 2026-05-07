export type ViewerMode = "management" | "production" | "installation";

export type ElementCategory =
  | "assemblies"
  | "beams"
  | "columns"
  | "plates"
  | "bolts"
  | "other";

export interface Element {
  expressId: number;
  ifcType: string;
  name?: string;
  assemblyMark?: string;
  partMark?: string;
  profile?: string;
  material?: string;
  weightKg?: number;
  lengthMm?: number;
  dimensions?: string;
  category: ElementCategory;
}

export interface Part {
  expressId: number;
  mark?: string;
  type: string;
  profile?: string;
  material?: string;
  lengthMm?: number;
  dimensions?: string;
  weightKg?: number;
}

export interface Assembly {
  id: string;
  mark?: string;
  name?: string;
  expressIds: number[];
  weightKg?: number;
  partCount: number;
  parts: Part[];
}

export interface AnalyzerPart {
  id: string;
  expressId: number | null;
  ifcType: string;
  name: string | null;
  tag: string | null;
  /** Resolved human-readable mark (Tekla / IFC), avoids GUID-like Tags */
  partMark?: string | null;
  profile: string | null;
  material: string | null;
  lengthMm: number | null;
  weightKg: number | null;
  xDim: number | null;
  yDim: number | null;
  thickness: number | null;
  /** IFC Profile `WallThickness` only — UI shows עובי דופן when present */
  wallThicknessMm?: number | null;
  /** Tekla Quantity / IFC when present */
  quantity?: number | null;
  /** Tekla Common — local/story elevations (mm after analyzer normalization) */
  topElevation?: number | null;
  bottomElevation?: number | null;
}

/** Flattened bolt / mechanical fastener row from Tekla Bolt Pset */
export interface AnalyzerBoltRow {
  id: string;
  expressId: number | null;
  ifcType: string;
  name: string | null;
  tag: string | null;
  boltName: string | null;
  boltLengthMm: number | null;
  boltStandard: string | null;
  boltHoleDiameterMm: number | null;
  /** Pieces represented by this IFC entity (e.g. bolt group quantity) */
  boltQty: number | null;
}

export type AnalyzerIndexedEntity = AnalyzerPart | AnalyzerBoltRow;

export function isAnalyzerBoltRow(e: AnalyzerIndexedEntity): e is AnalyzerBoltRow {
  return typeof e === "object" && e !== null && "boltQty" in e;
}

export interface AnalyzerAssembly {
  id: string;
  expressId: number | null;
  ifcType: "IfcElementAssembly";
  name: string | null;
  tag: string | null;
  assemblyMark: string | null;
  positionCode: string | null;
  weightKg: number | null;
  bottomElevation: number | null;
  topElevation: number | null;
  /** Steel parts only (fasteners excluded) */
  parts: AnalyzerPart[];
  bolts?: AnalyzerBoltRow[];
}

export interface AnalyzerOutput {
  assemblies: AnalyzerAssembly[];
  parts: AnalyzerIndexedEntity[];
}
