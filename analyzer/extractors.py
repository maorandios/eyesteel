from __future__ import annotations

from typing import Any

import ifcopenshell.util.element as element

from .units import UnitConverter


def extract_assembly_data(
    assembly: Any,
    converter: UnitConverter,
    *,
    debug_hits: list[str] | None = None,
) -> dict[str, Any]:
    psets = _safe_psets(assembly)
    tekla_assembly = _get_pset_case_insensitive(psets, ["Tekla Assembly"])

    assembly_mark = _pick_string(
        tekla_assembly,
        [
            "Assembly/Cast unit mark",
            "Cast unit mark",
            "AssemblyMark",
            "MARK",
        ],
        debug_hits,
    )
    position_code = _pick_string(
        tekla_assembly,
        [
            "Assembly/Cast unit position code",
            "Position code",
            "PositionCode",
        ],
        debug_hits,
    )
    weight_raw = _pick_value(
        tekla_assembly,
        [
            "Assembly/Cast unit weight",
            "Weight",
        ],
        debug_hits,
    )
    bottom_raw = _pick_value(
        tekla_assembly,
        [
            "Assembly/Cast unit bottom elevation",
            "Bottom elevation",
            "BottomElevation",
        ],
        debug_hits,
    )
    top_raw = _pick_value(
        tekla_assembly,
        [
            "Assembly/Cast unit top elevation",
            "Top elevation",
            "TopElevation",
        ],
        debug_hits,
    )

    weight_kg = converter.to_kg(weight_raw)
    if weight_kg is None:
        weight_kg = _find_numeric_by_key_contains(psets, "weight", converter.to_kg, debug_hits)

    return {
        "id": _entity_uid(assembly),
        "expressId": _entity_express_id(assembly),
        "ifcType": "IfcElementAssembly",
        "name": _normalize_string(getattr(assembly, "Name", None)),
        "tag": _normalize_string(getattr(assembly, "Tag", None)),
        "assemblyMark": assembly_mark,
        "positionCode": position_code,
        "weightKg": weight_kg,
        "bottomElevation": converter.to_mm(bottom_raw),
        "topElevation": converter.to_mm(top_raw),
    }


def extract_part_data(
    part: Any,
    converter: UnitConverter,
    *,
    debug_hits: list[str] | None = None,
) -> dict[str, Any]:
    psets = _safe_psets(part)
    profile_pset = _get_pset_case_insensitive(psets, ["Profile"])
    quantity_pset = _get_pset_case_insensitive(psets, ["Tekla Quantity"])

    profile = _pick_string(profile_pset, ["ProfileName", "Profile", "Section"], debug_hits)
    if profile is None:
        profile = _find_string_by_key_contains(
            psets,
            ("profile", "section", "cross section"),
            debug_hits,
        )

    x_dim = converter.to_mm(_pick_value(profile_pset, ["XDim", "Width"], debug_hits))
    y_dim = converter.to_mm(_pick_value(profile_pset, ["YDim", "Height"], debug_hits))
    thickness = converter.to_mm(
        _pick_value(profile_pset, ["WallThickness", "Thickness", "t"], debug_hits)
    )

    length_mm = converter.to_mm(_pick_value(quantity_pset, ["Length", "TotalLength"], debug_hits))
    if length_mm is None:
        length_mm = _find_numeric_by_key_contains(psets, "length", converter.to_mm, debug_hits)

    weight_kg = converter.to_kg(_pick_value(quantity_pset, ["Weight", "Mass"], debug_hits))
    if weight_kg is None:
        weight_kg = _find_numeric_by_key_contains(psets, "weight", converter.to_kg, debug_hits)

    material = _pick_string(
        _get_pset_case_insensitive(psets, ["Material"]),
        ["Material", "Grade", "Name"],
        debug_hits,
    )
    if material is None:
        material = _material_from_association(part)

    return {
        "id": _entity_uid(part),
        "expressId": _entity_express_id(part),
        "ifcType": part.is_a(),
        "name": _normalize_string(getattr(part, "Name", None)),
        "tag": _normalize_string(getattr(part, "Tag", None)),
        "profile": profile,
        "material": _normalize_string(material),
        "lengthMm": length_mm,
        "weightKg": weight_kg,
        "xDim": x_dim,
        "yDim": y_dim,
        "thickness": thickness,
    }


def get_entity_psets(entity: Any) -> dict[str, Any]:
    return _safe_psets(entity)


def iter_assembly_parts(assembly: Any):
    for rel in getattr(assembly, "IsDecomposedBy", []) or []:
        for obj in getattr(rel, "RelatedObjects", []) or []:
            if hasattr(obj, "is_a"):
                yield obj


def _safe_psets(entity: Any) -> dict[str, Any]:
    try:
        psets = element.get_psets(entity) or {}
        if isinstance(psets, dict):
            return psets
        return {}
    except Exception:
        return {}


def _get_pset_case_insensitive(psets: dict[str, Any], names: list[str]) -> dict[str, Any]:
    lowered = {str(k).strip().lower(): k for k in psets.keys()}
    for name in names:
        original = lowered.get(name.lower())
        if original is not None and isinstance(psets.get(original), dict):
            return psets[original]
    return {}


def _pick_string(source: dict[str, Any], keys: list[str], debug_hits: list[str] | None) -> str | None:
    value = _pick_value(source, keys, debug_hits)
    return _normalize_string(value)


def _pick_value(source: dict[str, Any], keys: list[str], debug_hits: list[str] | None) -> Any:
    if not isinstance(source, dict):
        return None
    key_map = {str(k).strip().lower(): k for k in source.keys()}
    for key in keys:
        original = key_map.get(key.lower())
        if original is not None:
            if debug_hits is not None:
                debug_hits.append(str(original))
            return source.get(original)
    return None


def _find_numeric_by_key_contains(
    psets: dict[str, Any],
    needle: str,
    convert,
    debug_hits: list[str] | None,
) -> float | None:
    for pset_name, pset in psets.items():
        if not isinstance(pset, dict):
            continue
        for key, value in pset.items():
            if needle.lower() in str(key).lower():
                converted = convert(value)
                if converted is not None:
                    if debug_hits is not None:
                        debug_hits.append(f"{pset_name}.{key}")
                    return converted
    return None


def _find_string_by_key_contains(
    psets: dict[str, Any],
    needles: tuple[str, ...],
    debug_hits: list[str] | None,
) -> str | None:
    for pset_name, pset in psets.items():
        if not isinstance(pset, dict):
            continue
        for key, value in pset.items():
            lowered = str(key).lower()
            if any(needle in lowered for needle in needles):
                normalized = _normalize_string(value)
                if normalized:
                    if debug_hits is not None:
                        debug_hits.append(f"{pset_name}.{key}")
                    return normalized
    return None


def _material_from_association(entity: Any) -> str | None:
    for rel in getattr(entity, "HasAssociations", []) or []:
        if not rel.is_a("IfcRelAssociatesMaterial"):
            continue
        material = getattr(rel, "RelatingMaterial", None)
        if material is None:
            continue
        for attr in ("Name", "LayerSetName"):
            candidate = _normalize_string(getattr(material, attr, None))
            if candidate:
                return candidate
        nested = getattr(material, "ForLayerSet", None)
        if nested is not None:
            candidate = _normalize_string(getattr(nested, "LayerSetName", None))
            if candidate:
                return candidate
    return None


def _normalize_string(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    text = value.strip()
    return text or None


def _entity_uid(entity: Any) -> str:
    global_id = _normalize_string(getattr(entity, "GlobalId", None))
    if global_id:
        return global_id
    try:
        return str(entity.id())
    except Exception:
        return "unknown"


def _entity_express_id(entity: Any) -> int | None:
    try:
        return int(entity.id())
    except Exception:
        return None
