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
  profile: string | null;
  material: string | null;
  lengthMm: number | null;
  weightKg: number | null;
  xDim: number | null;
  yDim: number | null;
  thickness: number | null;
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
  parts: AnalyzerPart[];
}

export interface AnalyzerOutput {
  assemblies: AnalyzerAssembly[];
  parts: AnalyzerPart[];
}
