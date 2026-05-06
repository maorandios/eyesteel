from __future__ import annotations

from typing import Any

import ifcopenshell

from .debug import debug_entity
from .extractors import (
    extract_assembly_data,
    extract_part_data,
    get_entity_psets,
    iter_assembly_parts,
)
from .units import build_unit_converter


def extract_model_data(ifc_file: str, debug: bool = False) -> dict[str, list[dict[str, Any]]]:
    model = ifcopenshell.open(ifc_file)
    converter = build_unit_converter(model)

    assemblies_out: list[dict[str, Any]] = []
    parts_index: dict[str, dict[str, Any]] = {}

    for assembly in model.by_type("IfcElementAssembly"):
        assembly_hits: list[str] = []
        assembly_out = extract_assembly_data(assembly, converter, debug_hits=assembly_hits)
        assembly_out["parts"] = []

        if debug:
            debug_entity(assembly, get_entity_psets(assembly), assembly_hits)

        for part in iter_assembly_parts(assembly):
            part_hits: list[str] = []
            part_out = extract_part_data(part, converter, debug_hits=part_hits)
            assembly_out["parts"].append(part_out)
            parts_index[part_out["id"]] = part_out

            if debug:
                debug_entity(part, get_entity_psets(part), part_hits)

        assemblies_out.append(assembly_out)

    return {
        "assemblies": assemblies_out,
        "parts": list(parts_index.values()),
    }
