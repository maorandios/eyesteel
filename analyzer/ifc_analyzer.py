from __future__ import annotations

import sys
from typing import Any

import ifcopenshell

from .debug import debug_entity
from .extractors import (
    extract_assembly_data,
    extract_fastener_data,
    extract_part_data,
    get_entity_psets,
    is_connection_bolt_row,
    is_fastener_entity,
    iter_assembly_leaf_products,
    iter_fallback_scan_entities,
)
from .units import build_unit_converter

_SKIP_FALLBACK_ENTITY_TYPES = frozenset(
    {
        "IfcSite",
        "IfcBuilding",
        "IfcBuildingStorey",
        "IfcSpace",
        "IfcZone",
        "IfcGrid",
        "IfcOpeningElement",
        "IfcAnnotation",
        "IfcProject",
    }
)


def _extract_parts_flat(model: Any, converter: Any, debug: bool) -> dict[str, dict[str, Any]]:
    """No IfcElementAssembly in file: index steel parts and connection bolts only (no virtual assemblies)."""
    parts_index: dict[str, dict[str, Any]] = {}

    for ent in iter_fallback_scan_entities(model):
        try:
            tname = ent.is_a()
        except Exception:
            continue
        if tname in _SKIP_FALLBACK_ENTITY_TYPES:
            continue

        if is_fastener_entity(ent):
            part_hits: list[str] = []
            bolt_out = extract_fastener_data(ent, converter, debug_hits=part_hits)
            if not is_connection_bolt_row(ent, bolt_out):
                continue
            if debug:
                debug_entity(ent, get_entity_psets(ent), part_hits)
            parts_index[bolt_out["id"]] = bolt_out
        else:
            part_hits: list[str] = []
            part_out = extract_part_data(ent, converter, debug_hits=part_hits)
            if debug:
                debug_entity(ent, get_entity_psets(ent), part_hits)
            parts_index[part_out["id"]] = part_out

    return parts_index


def extract_model_data(ifc_file: str, debug: bool = False) -> dict[str, list[dict[str, Any]]]:
    model = ifcopenshell.open(ifc_file)
    converter = build_unit_converter(model)

    assemblies_out: list[dict[str, Any]] = []
    parts_index: dict[str, dict[str, Any]] = {}

    real_assemblies = list(model.by_type("IfcElementAssembly"))

    if real_assemblies:
        for assembly in real_assemblies:
            assembly_hits: list[str] = []
            assembly_out = extract_assembly_data(assembly, converter, debug_hits=assembly_hits)
            assembly_out["parts"] = []
            assembly_out["bolts"] = []

            if debug:
                debug_entity(assembly, get_entity_psets(assembly), assembly_hits)

            seen_steel_ids: set[str] = set()
            seen_bolt_ids: set[str] = set()
            for part in iter_assembly_leaf_products(assembly):
                part_hits: list[str] = []
                if is_fastener_entity(part):
                    bolt_out = extract_fastener_data(part, converter, debug_hits=part_hits)
                    if not is_connection_bolt_row(part, bolt_out):
                        continue
                    bid = bolt_out["id"]
                    if bid in seen_bolt_ids:
                        continue
                    seen_bolt_ids.add(bid)
                    assembly_out["bolts"].append(bolt_out)
                    parts_index[bolt_out["id"]] = bolt_out
                else:
                    part_out = extract_part_data(part, converter, debug_hits=part_hits)
                    pid = part_out["id"]
                    if pid in seen_steel_ids:
                        continue
                    seen_steel_ids.add(pid)
                    assembly_out["parts"].append(part_out)
                    parts_index[part_out["id"]] = part_out

                if debug:
                    debug_entity(part, get_entity_psets(part), part_hits)

            assemblies_out.append(assembly_out)

        print(
            f"[eyesteel-ifc] Real assemblies: {len(assemblies_out)}, "
            f"flat export fallback: no",
            file=sys.stderr,
        )
    else:
        parts_index = _extract_parts_flat(model, converter, debug)
        print(
            f"[eyesteel-ifc] Real assemblies: 0; parts/bolts indexed flat: {len(parts_index)}",
            file=sys.stderr,
        )

    return {
        "assemblies": assemblies_out,
        "parts": list(parts_index.values()),
    }
