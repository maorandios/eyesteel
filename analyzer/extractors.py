from __future__ import annotations

import re
from typing import Any

import ifcopenshell.util.element as element

from .units import UnitConverter, _to_float, elevation_raw_to_mm, length_quantity_raw_to_mm


def _normalize_prop_key(key: str) -> str:
    """Match Tekla / IFC keys despite fullwidth slashes and odd spaces."""
    s = str(key).strip().lower()
    s = s.replace("\uff0f", "/").replace("\u2044", "/")
    s = s.replace("\xa0", " ").replace("\u2009", " ").replace("\u202f", " ")
    s = " ".join(s.split())
    return s


def _merge_pset_dicts(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Merge property sets by name; dict-valued entries merge keys with overlay winning."""
    out = dict(base)
    for name, blob in overlay.items():
        if isinstance(blob, dict) and isinstance(out.get(name), dict):
            merged = dict(out[name])
            merged.update(blob)
            out[name] = merged
        else:
            out[name] = blob
    return out


def _safe_psets_merged_with_type(entity: Any) -> dict[str, Any]:
    """Instance psets plus type-definition psets (Tekla often puts template data on the type)."""
    inst = _safe_psets(entity)
    try:
        decl = element.get_type(entity)
    except Exception:
        return inst
    if decl is None:
        return inst
    return _merge_pset_dicts(_safe_psets(decl), inst)


def _unwrap_numeric_property_value(raw: Any) -> Any:
    """IfcOpenShell may return lists (enumerations), dicts (bounded values), or wrapped entities."""
    if raw is None:
        return None
    if isinstance(raw, (int, float, str, bool)):
        return raw
    if isinstance(raw, list):
        if len(raw) == 1:
            return _unwrap_numeric_property_value(raw[0])
        for item in raw:
            if _to_float(item) is not None:
                return item
        return raw
    if isinstance(raw, dict):
        for key in ("NominalValue", "SetPointValue", "UpperBoundValue", "LowerBoundValue", "value"):
            if key in raw:
                return _unwrap_numeric_property_value(raw[key])
        return raw
    wrapped = getattr(raw, "wrappedValue", None)
    if wrapped is not None:
        return _unwrap_numeric_property_value(wrapped)
    return raw


def _iter_element_assembly_aggregate_chain(entity: Any):
    """Self, then aggregate/nest parents — Tekla often writes cast elevations only on the outer assembly."""
    cur: Any = entity
    seen: set[int] = set()
    for _ in range(24):
        if cur is None or id(cur) in seen:
            break
        seen.add(id(cur))
        try:
            if cur.is_a("IfcElementAssembly"):
                yield cur
        except Exception:
            pass
        try:
            parent = element.get_aggregate(cur)
            if parent is None:
                parent = element.get_nest(cur)
        except Exception:
            parent = None
        cur = parent


_CAST_BOTTOM_KEYS = frozenset({"assembly/cast unit bottom elevation", "cast unit bottom elevation"})
_CAST_TOP_KEYS = frozenset({"assembly/cast unit top elevation", "cast unit top elevation"})
_TEKLA_ASSEMBLY_PSET_NAMES = ("Tekla Assembly",)


def _direct_tekla_cast_elevation_raw(ent: Any, role: str, debug_hits: list[str] | None) -> Any:
    """Use ifcopenshell get_pset (exact names + inheritance) before dict scans."""
    bottom_props = (
        "Assembly/Cast unit bottom elevation",
        "Assembly/Cast Unit Bottom Elevation",
        "Cast unit bottom elevation",
    )
    top_props = (
        "Assembly/Cast unit top elevation",
        "Assembly/Cast Unit Top Elevation",
        "Cast unit top elevation",
    )
    props = bottom_props if role == "bottom" else top_props
    for pset_name in _TEKLA_ASSEMBLY_PSET_NAMES:
        for prop in props:
            try:
                val = element.get_pset(ent, pset_name, prop)
            except Exception:
                val = None
            if val is not None:
                if debug_hits is not None:
                    debug_hits.append(f"{pset_name}.{prop}")
                return val
    return None


def _find_cast_unit_elevation_raw(
    psets: dict[str, Any],
    role: str,
    debug_hits: list[str] | None = None,
) -> Any:
    """Tekla → IFC property names for cast unit bottom/top elevation (storey coordinates)."""
    wanted = _CAST_BOTTOM_KEYS if role == "bottom" else _CAST_TOP_KEYS
    role_word = "bottom" if role == "bottom" else "top"
    ta = _get_pset_case_insensitive(psets, ["Tekla Assembly"])
    if isinstance(ta, dict):
        for prop_key, val in ta.items():
            if str(prop_key).strip().lower() == "id":
                continue
            if _normalize_prop_key(str(prop_key)) in wanted:
                if debug_hits is not None:
                    debug_hits.append(str(prop_key))
                return val
        for prop_key, val in ta.items():
            if str(prop_key).strip().lower() == "id":
                continue
            kl = _normalize_prop_key(str(prop_key)).replace("_", " ")
            if role_word not in kl or "elevation" not in kl:
                continue
            if any(x in kl for x in ("part", "plate", "profile")):
                continue
            if debug_hits is not None:
                debug_hits.append(str(prop_key))
            return val
    for blob in psets.values():
        if not isinstance(blob, dict):
            continue
        for prop_key, val in blob.items():
            if _normalize_prop_key(str(prop_key)) in wanted:
                if debug_hits is not None:
                    debug_hits.append(str(prop_key))
                return val
    for blob in psets.values():
        if not isinstance(blob, dict):
            continue
        for prop_key, val in blob.items():
            kl = _normalize_prop_key(str(prop_key)).replace("_", " ")
            if role_word not in kl or "elevation" not in kl:
                continue
            if not ("assembly" in kl and "cast" in kl and "unit" in kl):
                continue
            if debug_hits is not None:
                debug_hits.append(str(prop_key))
            return val
    return None


def _resolve_cast_unit_elevation_raw(
    assembly: Any,
    role: str,
    debug_hits: list[str] | None = None,
) -> Any:
    """Walk this assembly and aggregate/nest parents until Tekla cast elevations are found."""
    for asm in _iter_element_assembly_aggregate_chain(assembly):
        hit = _direct_tekla_cast_elevation_raw(asm, role, debug_hits)
        if hit is not None:
            return hit
        layer = _safe_psets_merged_with_type(asm)
        hit = _find_cast_unit_elevation_raw(layer, role, debug_hits)
        if hit is not None:
            return hit
    return None


def extract_assembly_data(
    assembly: Any,
    converter: UnitConverter,
    *,
    debug_hits: list[str] | None = None,
) -> dict[str, Any]:
    psets = _safe_psets_merged_with_type(assembly)
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
    bottom_raw = _resolve_cast_unit_elevation_raw(assembly, "bottom", debug_hits)
    top_raw = _resolve_cast_unit_elevation_raw(assembly, "top", debug_hits)

    bottom_mm = (
        elevation_raw_to_mm(_unwrap_numeric_property_value(bottom_raw), converter)
        if bottom_raw is not None
        else None
    )
    top_mm = (
        elevation_raw_to_mm(_unwrap_numeric_property_value(top_raw), converter)
        if top_raw is not None
        else None
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
        "bottomElevation": bottom_mm,
        "topElevation": top_mm,
    }


_FALLBACK_SCAN_IFC_TYPES: tuple[str, ...] = (
    "IfcBeam",
    "IfcColumn",
    "IfcMember",
    "IfcPlate",
    "IfcBuildingElementProxy",
)


def iter_fallback_scan_entities(model: Any):
    """IfcProduct scan after explicit types; de-dupe by entity id()."""
    seen: set[int] = set()
    for type_name in _FALLBACK_SCAN_IFC_TYPES:
        try:
            for ent in model.by_type(type_name):
                try:
                    eid = int(ent.id())
                except Exception:
                    continue
                if eid in seen:
                    continue
                seen.add(eid)
                yield ent
        except Exception:
            continue
    try:
        for ent in model.by_type("IfcProduct"):
            try:
                eid = int(ent.id())
            except Exception:
                continue
            if eid in seen:
                continue
            seen.add(eid)
            yield ent
    except Exception:
        return


def merged_psets_for_fallback_scan(entity: Any) -> dict[str, Any]:
    """Instance + type + `should_inherit` psets for Tekla metadata often stored on supertypes."""
    merged = _safe_psets_merged_with_type(entity)
    try:
        inh = element.get_psets(entity, should_inherit=True) or {}
        if isinstance(inh, dict):
            merged = _merge_pset_dicts(inh, merged)
    except Exception:
        pass
    return merged


def entity_indicates_main_steel_part(entity: Any) -> bool:
    """Tekla / IFC flags like 'Main part' on bolts or part psets."""
    psets = merged_psets_for_fallback_scan(entity)
    for blob in psets.values():
        if not isinstance(blob, dict):
            continue
        for key, raw in blob.items():
            nk = _normalize_prop_key(str(key))
            if "main" not in nk:
                continue
            if "part" not in nk and "component" not in nk:
                continue
            val = _unwrap_numeric_property_value(raw)
            if isinstance(val, bool) and val:
                return True
            if isinstance(val, (int, float)) and float(val) != 0.0:
                return True
            s = _normalize_string(val)
            if s and s.upper() in ("YES", "Y", "TRUE", "1", "MAIN", "MAIN PART"):
                return True
    return False


_PROFILE_PURE_NUMERIC_RE = re.compile(r"^[+-]?(?:\d+[.,]?\d*|[.,]\d+)(?:[eE][+-]?\d+)?$")


_GENERIC_PROFILE_PLACEHOLDERS = frozenset(
    {"plate", "beam", "column", "member", "part", "bolt", "unnamed", "n/a", "-", "none"}
)


def _sanitize_profile_candidate(raw: str | None) -> str | None:
    """
    IFC often exposes Profile_* props as floats or bogus numeric literals that stringify to '0.0001'.
    Tekla catalogs (PLT25*220, SHS100*100*10) include letters and/or '*' — reject pure numbers.
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    if len(s) > 160:
        return None
    collapsed = s.replace(",", ".").replace("\u202f", "").replace("\xa0", "")
    if _PROFILE_PURE_NUMERIC_RE.fullmatch(collapsed):
        return None
    low = s.lower()
    if low in _GENERIC_PROFILE_PLACEHOLDERS:
        return None
    if re.search(r"[A-Za-z]", s):
        return s
    if "*" in s or "×" in s or "/" in s:
        return s
    # e.g. 100x100x10 (some exports omit profile letters)
    if re.search(r"\d\s*[x×]\s*\d", s, re.I):
        return s
    return None


def _profile_from_property_raw(raw: Any) -> str | None:
    return _sanitize_profile_candidate(_normalize_string(_unwrap_numeric_property_value(raw)))


_ELEMENT_SPECIFIC_PSET_NAMES = (
    "Element Specific",
    "ElementSpecific",
    "Elementspecific",
)

_DESCRIPTION_PROP_NAMES = ("Description", "description")


def _discovered_element_specific_pset_names(ent: Any) -> list[str]:
    """IFC uses varying pset spellings; discover keys that look like Element Specific."""
    try:
        ps = element.get_psets(ent, should_inherit=True, verbose=False) or {}
    except Exception:
        return []
    found: list[str] = []
    for name in ps.keys():
        n = _normalize_prop_key(str(name))
        if "element" in n and "specific" in n:
            found.append(str(name))
    return found


def _direct_element_specific_description(ent: Any, debug_hits: list[str] | None) -> str | None:
    """IfcOpenShell get_pset; Tekla UI often mirrors IfcRoot.Description into this pset."""
    if ent is None:
        return None
    names = list(
        dict.fromkeys(list(_ELEMENT_SPECIFIC_PSET_NAMES) + _discovered_element_specific_pset_names(ent))
    )
    for pset_name in names:
        for prop in _DESCRIPTION_PROP_NAMES:
            try:
                val = element.get_pset(ent, pset_name, prop)
            except Exception:
                val = None
            if val is None:
                continue
            hit = _profile_from_property_raw(val)
            if hit:
                if debug_hits is not None:
                    debug_hits.append(f"{pset_name}.{prop}")
                return hit
    return None


def _ifc_root_profile_description(ent: Any, debug_hits: list[str] | None, tag: str) -> str | None:
    """Native schema field — viewers often list it under 'Element Specific' with property Description."""
    if ent is None:
        return None
    hit = _profile_from_property_raw(getattr(ent, "Description", None))
    if hit:
        if debug_hits is not None:
            debug_hits.append(tag)
        return hit
    return None


def _pset_sort_key(pname: str) -> tuple[int, str]:
    n = _normalize_prop_key(str(pname))
    if "element" in n and "specific" in n:
        return (0, str(pname))
    if "tekla" in n:
        return (1, str(pname))
    return (2, str(pname))


def _scan_psets_for_profile_descriptions(psets: dict[str, Any], debug_hits: list[str] | None) -> str | None:
    """Any pset property named Description (or containing 'description'), unwrap IFC wrappers."""
    items = sorted(psets.items(), key=lambda kv: _pset_sort_key(kv[0]))
    candidates: list[tuple[Any, Any, Any]] = []
    for pname, blob in items:
        if not isinstance(blob, dict):
            continue
        for key, val in blob.items():
            if str(key).strip().lower() == "id":
                continue
            kn = _normalize_prop_key(str(key)).replace("_", " ")
            if kn in ("description", "ifcdescription"):
                candidates.append((pname, key, val))
            elif "description" in kn:
                if any(bad in kn for bad in ("bolt", "assembly", "project", "building", "site")):
                    continue
                candidates.append((pname, key, val))

    for pname, key, val in candidates:
        hit = _profile_from_property_raw(val)
        if hit:
            if debug_hits is not None:
                debug_hits.append(f"{pname}.{key}")
            return hit
    return None


def _resolve_part_profile(part: Any, psets: dict[str, Any], debug_hits: list[str] | None) -> str | None:
    """Prefer native IfcRoot.Description, then Element Specific / Description on instance & type, then any Description."""
    hit = _ifc_root_profile_description(part, debug_hits, "IfcRoot.Description")
    if hit:
        return hit

    try:
        decl = element.get_type(part)
    except Exception:
        decl = None

    hit = _ifc_root_profile_description(decl, debug_hits, "IfcRoot.Description(type)")
    if hit:
        return hit

    hit = _direct_element_specific_description(part, debug_hits)
    if hit:
        return hit

    hit = _direct_element_specific_description(decl, debug_hits)
    if hit:
        return hit

    elem_specific = _get_pset_case_insensitive(psets, ["Element Specific", "ElementSpecific"])
    hit = _profile_from_property_raw(_pick_value(elem_specific, ["Description"], debug_hits))
    if hit:
        return hit

    for pname, blob in psets.items():
        if not isinstance(blob, dict):
            continue
        pn = _normalize_prop_key(str(pname))
        if "element" not in pn or "specific" not in pn:
            continue
        hit = _profile_from_property_raw(_pick_value(blob, ["Description"], debug_hits))
        if hit:
            return hit

    hit = _scan_psets_for_profile_descriptions(psets, debug_hits)
    if hit:
        return hit

    try:
        verbose_psets = element.get_psets(part, should_inherit=True, verbose=True) or {}
    except Exception:
        verbose_psets = {}
    hit = _scan_psets_for_profile_descriptions(verbose_psets, debug_hits)
    if hit:
        return hit

    return None


_TEKLA_COMMON_PSET_NAMES = ("Tekla Common",)

_TOP_ELEVATION_PROPS = (
    "Top elevation",
    "Top Elevation",
)
_BOTTOM_ELEVATION_PROPS = (
    "Bottom elevation",
    "Bottom Elevation",
)


def _direct_tekla_common_part_elevation_raw(
    ent: Any, role: str, debug_hits: list[str] | None
) -> Any:
    """Single-member Top/Bottom elevation from Tekla Common (not cast-unit assembly elevations)."""
    if ent is None:
        return None
    props = _TOP_ELEVATION_PROPS if role == "top" else _BOTTOM_ELEVATION_PROPS
    for pset_name in _TEKLA_COMMON_PSET_NAMES:
        for prop in props:
            try:
                val = element.get_pset(ent, pset_name, prop)
            except Exception:
                val = None
            if val is not None:
                if debug_hits is not None:
                    debug_hits.append(f"{pset_name}.{prop}")
                return val
    return None


def _find_tekla_common_part_elevation_raw(
    psets: dict[str, Any], role: str, debug_hits: list[str] | None
) -> Any:
    tc = _get_pset_case_insensitive(psets, ["Tekla Common"])
    if not isinstance(tc, dict):
        return None
    role_word = "top" if role == "top" else "bottom"
    for prop_key, val in tc.items():
        if str(prop_key).strip().lower() == "id":
            continue
        kl = _normalize_prop_key(str(prop_key)).replace("_", " ")
        if "elevation" not in kl or role_word not in kl:
            continue
        if "assembly" in kl and "cast" in kl and "unit" in kl:
            continue
        if debug_hits is not None:
            debug_hits.append(str(prop_key))
        return val
    return None


def _resolve_part_local_elevation_mm(
    part: Any,
    psets: dict[str, Any],
    converter: UnitConverter,
    role: str,
    debug_hits: list[str] | None,
) -> float | None:
    raw = _direct_tekla_common_part_elevation_raw(part, role, debug_hits)
    if raw is None:
        try:
            decl = element.get_type(part)
        except Exception:
            decl = None
        raw = _direct_tekla_common_part_elevation_raw(decl, role, debug_hits)
    if raw is None:
        raw = _find_tekla_common_part_elevation_raw(psets, role, debug_hits)
    if raw is None:
        return None
    return elevation_raw_to_mm(_unwrap_numeric_property_value(raw), converter)


_PROFILE_PSET_NAMES_WALL = (
    "Profile",
    "Pset_ProfileCommon",
)


def _direct_wall_thickness_raw(ent: Any, debug_hits: list[str] | None) -> Any:
    if ent is None:
        return None
    props = ("WallThickness", "Wall thickness")
    for pset_name in _PROFILE_PSET_NAMES_WALL:
        for prop in props:
            try:
                val = element.get_pset(ent, pset_name, prop)
            except Exception:
                val = None
            if val is not None:
                if debug_hits is not None:
                    debug_hits.append(f"{pset_name}.{prop}")
                return val
    return None


def _scan_psets_for_wall_thickness_raw(psets: dict[str, Any], debug_hits: list[str] | None) -> Any:
    """WallThickness may live under a differently spelled Profile set or duplicated on Tekla psets."""
    best: tuple[int, str, str, Any] | None = None
    for pname, blob in psets.items():
        if not isinstance(blob, dict):
            continue
        pn_norm = _normalize_prop_key(str(pname))
        p_bonus = 3 if "profile" in pn_norm.replace(" ", "") else 0
        for key, val in blob.items():
            if str(key).strip().lower() == "id":
                continue
            kl = _normalize_prop_key(str(key))
            compact = kl.replace(" ", "").replace("_", "").replace("-", "")
            if compact == "wallthickness" or compact.endswith("wallthickness"):
                rank = p_bonus + len(compact)
                cand = (rank, str(pname), str(key), val)
                if best is None or rank > best[0]:
                    best = cand
    if best is None:
        return None
    if debug_hits is not None:
        debug_hits.append(f"{best[1]}.{best[2]}")
    return best[3]


def _wall_thickness_mm_from_profile_catalog(profile: str | None) -> float | None:
    """Last segment wall thickness for hollow catalogs (RHS…*5) or second segment (TUBE273*8)."""
    if not profile:
        return None
    u = profile.strip().upper()
    segs = [s.strip() for s in re.split(r"\*", u) if s.strip()]
    if len(segs) < 2:
        return None
    hollow_prefix = ("RHS", "SHS", "CHS", "TUBE", "PIPE")
    if not any(segs[0].startswith(p) for p in hollow_prefix):
        return None
    tail = segs[-1] if len(segs) >= 3 else segs[1]
    m = re.match(r"^(\d+(?:[.,]\d+)?)", tail)
    if not m:
        return None
    try:
        v = float(m.group(1).replace(",", "."))
    except ValueError:
        return None
    return v if v > 0 else None


def _resolve_wall_thickness_mm(
    part: Any,
    psets: dict[str, Any],
    profile_pset: dict[str, Any],
    converter: UnitConverter,
    profile_str: str | None,
    debug_hits: list[str] | None,
) -> float | None:
    raw = _pick_value(profile_pset, ["WallThickness", "Wall thickness"], debug_hits)
    if raw is None:
        raw = _direct_wall_thickness_raw(part, debug_hits)
    if raw is None:
        try:
            decl = element.get_type(part)
        except Exception:
            decl = None
        raw = _direct_wall_thickness_raw(decl, debug_hits)
    if raw is None:
        raw = _scan_psets_for_wall_thickness_raw(psets, debug_hits)
    if raw is None:
        try:
            vp = element.get_psets(part, should_inherit=True, verbose=True) or {}
        except Exception:
            vp = {}
        raw = _scan_psets_for_wall_thickness_raw(vp, debug_hits)
    if raw is not None:
        mm = converter.to_mm(_unwrap_numeric_property_value(raw))
        if mm is not None:
            return mm
    return _wall_thickness_mm_from_profile_catalog(profile_str)


def extract_part_data(
    part: Any,
    converter: UnitConverter,
    *,
    debug_hits: list[str] | None = None,
) -> dict[str, Any]:
    psets = _safe_psets_merged_with_type(part)
    profile_pset = _get_pset_case_insensitive(psets, ["Profile"])
    quantity_pset = _get_pset_case_insensitive(psets, ["Tekla Quantity"])

    profile = _resolve_part_profile(part, psets, debug_hits)

    x_dim = converter.to_mm(_pick_value(profile_pset, ["XDim", "Width"], debug_hits))
    y_dim = converter.to_mm(_pick_value(profile_pset, ["YDim", "Height"], debug_hits))
    wall_thickness_mm = _resolve_wall_thickness_mm(
        part, psets, profile_pset, converter, profile, debug_hits
    )
    thickness = converter.to_mm(
        _pick_value(profile_pset, ["WallThickness", "Thickness", "t"], debug_hits)
    )

    if x_dim is None:
        x_dim = converter.to_mm(_pick_value(quantity_pset, ["Width"], debug_hits))
    if y_dim is None:
        y_dim = converter.to_mm(_pick_value(quantity_pset, ["Height"], debug_hits))

    length_mm = converter.to_mm(_pick_value(quantity_pset, ["Length", "TotalLength"], debug_hits))
    if length_mm is None:
        length_mm = _find_numeric_by_key_contains(psets, "length", converter.to_mm, debug_hits)

    weight_kg = converter.to_kg(_pick_value(quantity_pset, ["Weight", "Mass"], debug_hits))
    if weight_kg is None:
        weight_kg = _find_numeric_by_key_contains(psets, "weight", converter.to_kg, debug_hits)

    quantity = _normalize_quantity(
        _pick_value(
            quantity_pset,
            [
                "Quantity",
                "QTY",
                "Count",
                "NumberOfPieces",
                "Piece count",
                "Pieces",
            ],
            debug_hits,
        )
    )

    material = _pick_string(
        _get_pset_case_insensitive(psets, ["Material"]),
        ["Material", "Grade", "Name"],
        debug_hits,
    )
    if material is None:
        material = _material_from_association(part)

    part_mark = _resolve_part_mark(part, psets, debug_hits)

    top_mm = _resolve_part_local_elevation_mm(part, psets, converter, "top", debug_hits)
    bottom_mm = _resolve_part_local_elevation_mm(part, psets, converter, "bottom", debug_hits)

    return {
        "id": _entity_uid(part),
        "expressId": _entity_express_id(part),
        "ifcType": part.is_a(),
        "name": _normalize_string(getattr(part, "Name", None)),
        "tag": _normalize_string(getattr(part, "Tag", None)),
        "partMark": part_mark,
        "profile": profile,
        "material": _normalize_string(material),
        "lengthMm": length_mm,
        "weightKg": weight_kg,
        "xDim": x_dim,
        "yDim": y_dim,
        "thickness": thickness,
        "wallThicknessMm": wall_thickness_mm,
        "quantity": quantity,
        "topElevation": top_mm,
        "bottomElevation": bottom_mm,
    }


def _bolt_quantity_raw(
    psets: dict[str, Any],
    bolt_pset: dict[str, Any] | None,
    debug_hits: list[str] | None,
) -> Any:
    bolt_pset = bolt_pset if isinstance(bolt_pset, dict) else {}

    keys_order = [
        "Quantity",
        "Qty",
        "Number of bolts",
        "Bolt quantity",
        "Bolt Quantity",
        "NumberOfBolts",
        "Bolt count",
        "Bolt Count",
        "Bolt Count Net",
        "Count",
        "Number",
        "Pieces",
        "BoltNumber",
        "Bolts",
        "Number Bolts",
    ]
    for k in keys_order:
        v = _pick_value(bolt_pset, [k], debug_hits)
        if v is not None and _normalize_quantity(v) is not None:
            return v

    qty_pset = _get_pset_case_insensitive(psets, ["Tekla Quantity"])
    if isinstance(qty_pset, dict):
        for k in keys_order:
            v = _pick_value(qty_pset, [k], debug_hits)
            if v is not None and _normalize_quantity(v) is not None:
                return v
        for key, val in qty_pset.items():
            kl = str(key).lower()
            if any(x in kl for x in ("quantity", "qty", "count", "number", "pieces")):
                if any(bad in kl for bad in ("weight", "mass", "area", "volume", "length")):
                    continue
                if _normalize_quantity(val) is not None:
                    return val

    for key, val in bolt_pset.items():
        kl = str(key).lower()
        if any(x in kl for x in ("quantity", "qty", "count", "number", "pieces")):
            if any(bad in kl for bad in ("diameter", "length", "hole", "pitch", "thread", "grade")):
                continue
            if _normalize_quantity(val) is not None:
                return val

    for blob in psets.values():
        if not isinstance(blob, dict):
            continue
        for key, val in blob.items():
            kl = str(key).lower()
            if "bolt" not in kl:
                continue
            if not any(x in kl for x in ("quantity", "qty", "count", "number", "pieces")):
                continue
            if _normalize_quantity(val) is not None:
                return val

    return None


def _fastener_nominal_length_mm(part: Any, converter: UnitConverter) -> float | None:
    raw = getattr(part, "NominalLength", None)
    if raw is None:
        return None
    return length_quantity_raw_to_mm(raw, converter)


def extract_fastener_data(
    part: Any,
    converter: UnitConverter,
    *,
    debug_hits: list[str] | None = None,
) -> dict[str, Any]:
    """Tekla Bolt / IFC mechanical fastener row for UI (one IFC entity, qty may be >1)."""
    psets = _safe_psets_merged_with_type(part)
    bolt_pset = _get_pset_case_insensitive(psets, ["Tekla Bolt", "Tekla Bolts"])

    bolt_name = _pick_string(
        bolt_pset,
        [
            "Bolt Name",
            "Bolt name",
            "Bolt type",
            "Name",
        ],
        debug_hits,
    )
    if bolt_name is None:
        bolt_name = _normalize_string(getattr(part, "Name", None))

    length_raw = _pick_value(
        bolt_pset,
        ["Bolt length", "Bolt Length", "Length"],
        debug_hits,
    )
    length_mm = length_quantity_raw_to_mm(length_raw, converter)
    if length_mm is None:
        length_mm = length_quantity_raw_to_mm(
            _find_raw_by_key_fragments(psets, ("bolt", "length")),
            converter,
        )
    if length_mm is None:
        length_mm = _fastener_nominal_length_mm(part, converter)

    standard = _pick_string(
        bolt_pset,
        ["Bolt standard", "Bolt Standard", "Standard", "Strength grade"],
        debug_hits,
    )

    hole_raw = _pick_value(
        bolt_pset,
        [
            "Bolt hole diameter",
            "Bolt Hole Diameter",
            "Hole diameter",
            "Hole Diameter",
            "Diameter",
        ],
        debug_hits,
    )
    hole_mm = length_quantity_raw_to_mm(hole_raw, converter)
    if hole_mm is None:
        hole_mm = length_quantity_raw_to_mm(
            _find_raw_by_key_fragments(psets, ("bolt", "hole")),
            converter,
        )

    qty_raw = _bolt_quantity_raw(psets, bolt_pset, debug_hits)
    qty = _normalize_quantity(qty_raw)
    if qty is None:
        qty = 1.0

    return {
        "id": _entity_uid(part),
        "expressId": _entity_express_id(part),
        "ifcType": part.is_a(),
        "name": bolt_name,
        "tag": _normalize_string(getattr(part, "Tag", None)),
        "boltName": bolt_name,
        "boltLengthMm": length_mm,
        "boltStandard": standard,
        "boltHoleDiameterMm": hole_mm,
        "boltQty": float(qty),
    }


def _find_raw_by_key_fragments(psets: dict[str, Any], fragments: tuple[str, ...]) -> Any:
    for blob in psets.values():
        if not isinstance(blob, dict):
            continue
        for key, val in blob.items():
            kl = str(key).lower()
            if all(f in kl for f in fragments):
                return val
    return None


def get_entity_psets(entity: Any) -> dict[str, Any]:
    return _safe_psets(entity)


def iter_assembly_parts(assembly: Any):
    """
    Direct children of an IfcElementAssembly via decomposition and nesting.

    IFC4 Tekla exports often hang sub-assemblies (e.g. single-member \"BEAM\"
    groups) only under ``IsNestedBy`` / ``IfcRelNests``. Traversing
    ``IsDecomposedBy`` alone misses those children, so parent cast units get
    no steel parts and picks resolve to the tiny nested row only.
    """
    seen: set[int] = set()

    def emit(obj: Any):
        if not hasattr(obj, "is_a"):
            return
        oid = id(obj)
        if oid in seen:
            return
        seen.add(oid)
        yield obj

    for rel in getattr(assembly, "IsDecomposedBy", []) or []:
        for obj in getattr(rel, "RelatedObjects", []) or []:
            yield from emit(obj)
    for rel in getattr(assembly, "IsNestedBy", []) or []:
        for obj in getattr(rel, "RelatedObjects", []) or []:
            yield from emit(obj)


def iter_assembly_leaf_products(assembly: Any):
    """Flatten nested IfcElementAssembly (e.g. Tekla bolt groups) into leaf products."""
    for obj in iter_assembly_parts(assembly):
        try:
            if obj.is_a("IfcElementAssembly"):
                yield from iter_assembly_leaf_products(obj)
            else:
                yield obj
        except Exception:
            yield obj


def is_fastener_entity(part: Any) -> bool:
    try:
        t = part.is_a()
    except Exception:
        return False
    if t in ("IfcMechanicalFastener", "IfcFastener"):
        return True
    upper = str(t).upper()
    if "FASTENER" in upper or "MECHANICALFASTENER" in upper:
        return True
    try:
        pt = getattr(part, "PredefinedType", None)
        if pt is not None:
            pts = str(pt).upper()
            if "BOLT" in pts or "FASTENER" in pts or "SCREW" in pts:
                return True
    except Exception:
        pass
    psets = _safe_psets_merged_with_type(part)
    if _get_pset_case_insensitive(psets, ["Tekla Bolt", "Tekla Bolts"]):
        return True
    return False


def should_exclude_hole_like_fastener(part: Any, bolt_row: dict[str, Any]) -> bool:
    """
    Tekla often exports visible hole solids as IfcMechanicalFastener + Tekla Bolt.
    Exclude obvious hole-only rows so the UI lists connection bolts.
    """
    bolt_name = (bolt_row.get("boltName") or "").strip().lower()
    part_name = (_normalize_string(getattr(part, "Name", None)) or "").lower()
    obj_type = (_normalize_string(getattr(part, "ObjectType", None)) or "").lower()
    combined = f"{bolt_name} {part_name} {obj_type}"

    if any(
        t in combined
        for t in (
            "hole",
            "חור",
            "opening",
            "void",
            "drilled hole",
            "shop hole",
            "countersunk hole",
            "rebate hole",
        )
    ):
        return True

    try:
        pt = getattr(part, "PredefinedType", None)
        if pt is not None:
            pts = str(pt).upper()
            if "HOLE" in pts or "OPENING" in pts:
                return True
    except Exception:
        pass

    psets = _safe_psets_merged_with_type(part)
    bolt_pset = _get_pset_case_insensitive(psets, ["Tekla Bolt", "Tekla Bolts"])
    for flag_key in ("Hole only", "Hole Only", "Is hole", "Fabrication hole"):
        v = _pick_value(bolt_pset, [flag_key], None)
        if isinstance(v, bool) and v:
            return True
        if isinstance(v, str) and v.strip().lower() in ("true", "yes", "1"):
            return True

    return False


def _tekla_bolt_pset_suggests_connection_hardware(blob: dict[str, Any]) -> bool:
    """Nut / washer / sleeve fields usually absent on plain hole solids."""
    if not isinstance(blob, dict):
        return False
    keywords = ("washer", "nut", "sleeve", "anchor", "thread", "grip length", "bolt assembly", "joint")
    for k, v in blob.items():
        kl = _normalize_prop_key(str(k))
        if not any(w in kl for w in keywords):
            continue
        if isinstance(v, bool) and v:
            return True
        q = _normalize_quantity(v)
        if q is not None and q > 0:
            return True
        fv = _to_float(v)
        if fv is not None and fv > 0:
            return True
        if isinstance(v, str) and v.strip().lower() in ("true", "yes", "1"):
            return True
    return False


def _catalog_length_mm_from_tekla_bolt_name(text: str | None) -> float | None:
    """
    Tekla catalog strings often encode length after '*' (e.g. BOLTM16*45 → 45 mm).
    Returns None when no pattern matches.
    """
    if not text:
        return None
    s = str(text).strip()
    matches = list(re.finditer(r"\*(\d+(?:[.,]\d+)?)", s))
    if not matches:
        return None
    raw = matches[-1].group(1).replace(",", ".")
    return _to_float(raw)


def _bolt_catalog_length_matches_actual_mm(bolt_row: dict[str, Any]) -> bool | None:
    """
    None → cannot decide (no *length in name or no actual length).
    True → matches within tolerance.
    False → catalog length conflicts with IFC length (hole / wrong solid).
    """
    catalog = _catalog_length_mm_from_tekla_bolt_name(
        (bolt_row.get("boltName") or bolt_row.get("name") or None),
    )
    if catalog is None:
        return None
    actual = bolt_row.get("boltLengthMm")
    if actual is None:
        return None
    try:
        actual_f = float(actual)
    except (TypeError, ValueError):
        return None
    # IFC rounding vs catalog; large mismatches (e.g. *100 vs 5 mm) indicate holes
    tol = max(2.0, abs(0.02 * catalog))
    if abs(catalog - actual_f) <= tol:
        return True
    return False


def is_connection_bolt_row(part: Any, bolt_row: dict[str, Any]) -> bool:
    """
    Keep fasteners that represent an actual connection bolt, not Tekla hole geometry.
    Tekla often copies bolt catalog names onto hole-only solids — grade alone is unreliable.
    """
    if should_exclude_hole_like_fastener(part, bolt_row):
        return False

    catalog_vs_actual = _bolt_catalog_length_matches_actual_mm(bolt_row)
    if catalog_vs_actual is False:
        return False

    psets = _safe_psets_merged_with_type(part)
    bolt_pset = _get_pset_case_insensitive(psets, ["Tekla Bolt", "Tekla Bolts"])
    length = bolt_row.get("boltLengthMm")
    if isinstance(length, (int, float)) and float(length) >= 3.0:
        return True
    if _tekla_bolt_pset_suggests_connection_hardware(bolt_pset):
        return True
    return False


def _pick_value_from_pset_keys_containing(
    pset: dict[str, Any],
    fragments: list[str],
    debug_hits: list[str] | None,
) -> Any:
    if not isinstance(pset, dict):
        return None
    lowered = [f.lower() for f in fragments]
    best_match: tuple[int, str, Any] | None = None
    for key, value in pset.items():
        kl = _normalize_prop_key(str(key))
        for frag in lowered:
            if frag in kl:
                specificity = len(frag)
                if best_match is None or specificity > best_match[0]:
                    best_match = (specificity, str(key), value)
                break
    if best_match is not None:
        if debug_hits is not None:
            debug_hits.append(best_match[1])
        return best_match[2]
    return None


def _looks_like_generated_id_tag(text: str | None) -> bool:
    if not text:
        return False
    s = str(text).strip()
    if len(s) < 20:
        return False
    core = s[2:] if s.upper().startswith("ID") else s
    parts = core.count("-")
    if parts >= 4 and len(core) >= 32:
        hexish = core.replace("-", "").replace("{", "").replace("}", "")
        return all(c in "0123456789abcdefABCDEF" for c in hexish)
    return False


def _reference_from_psets(psets: dict[str, Any]) -> str | None:
    exact_keys = [
        "Reference",
        "OBJECT_REFERENCE",
        "Object reference",
        "Part reference",
        "PART_REFERENCE",
    ]
    preferred_psets = [
        "Tekla Common",
        "Tekla Single Part",
        "Tekla Beam",
        "Tekla Plate",
        "Tekla Pipe",
        "Tekla Profile",
        "Tekla Assembly",
    ]
    for pname in preferred_psets:
        blob = _get_pset_case_insensitive(psets, [pname])
        if not blob:
            continue
        hit = _pick_string(blob, exact_keys, None)
        if hit and not _looks_like_generated_id_tag(hit):
            return hit

    for blob in psets.values():
        if not isinstance(blob, dict):
            continue
        hit = _pick_string(blob, exact_keys, None)
        if hit and not _looks_like_generated_id_tag(hit):
            return hit

    for blob in psets.values():
        if not isinstance(blob, dict):
            continue
        for key, val in blob.items():
            kl = str(key).lower()
            if "reference" not in kl:
                continue
            if "assembly/cast" in kl:
                continue
            hit = _normalize_string(val)
            if hit and not _looks_like_generated_id_tag(hit):
                return hit
    return None


def _looks_like_generic_type_label(text: str | None) -> bool:
    if not text:
        return True
    u = text.strip().upper()
    return u in ("PLATE", "BEAM", "COLUMN", "MEMBER", "BOLT", "PIPE", "CHORD", "BRACING")


def _resolve_part_mark(part: Any, psets: dict[str, Any], debug_hits: list[str] | None) -> str | None:
    ref = _reference_from_psets(psets)
    if ref:
        if debug_hits is not None:
            debug_hits.append("Reference")
        return ref

    raw_tag = _normalize_string(getattr(part, "Tag", None))
    if raw_tag and not _looks_like_generated_id_tag(raw_tag):
        if debug_hits is not None:
            debug_hits.append("IfcTag")
        return raw_tag

    mark_keys = [
        "Mark",
        "Piece Mark",
        "Piece mark",
        "Part mark",
        "PART_MARK",
        "Object Mark",
        "Assembling mark",
        "Cast unit mark",
    ]
    preferred_psets = [
        "Tekla Common",
        "Tekla Single Part",
        "Tekla Beam",
        "Tekla Plate",
        "Tekla Pipe",
        "Tekla Assembly",
    ]
    for pname in preferred_psets:
        blob = _get_pset_case_insensitive(psets, [pname])
        if not blob:
            continue
        hit = _pick_string(blob, mark_keys, None)
        if hit and not _looks_like_generated_id_tag(hit):
            return hit

    for _pname, blob in psets.items():
        if not isinstance(blob, dict):
            continue
        hit = _pick_string(blob, mark_keys, None)
        if hit and not _looks_like_generated_id_tag(hit):
            return hit

    name = _normalize_string(getattr(part, "Name", None))
    if name and not _looks_like_generated_id_tag(name) and not _looks_like_generic_type_label(name):
        return name

    eid = _entity_express_id(part)
    return f"#{eid}" if eid is not None else None


def _safe_psets(entity: Any) -> dict[str, Any]:
    try:
        psets = element.get_psets(entity) or {}
        if isinstance(psets, dict):
            return psets
        return {}
    except Exception:
        return {}


def _get_pset_case_insensitive(psets: dict[str, Any], names: list[str]) -> dict[str, Any]:
    lowered = {_normalize_prop_key(str(k)): k for k in psets.keys()}
    for name in names:
        original = lowered.get(_normalize_prop_key(name))
        if original is not None and isinstance(psets.get(original), dict):
            return psets[original]
    return {}


def _pick_string(source: dict[str, Any], keys: list[str], debug_hits: list[str] | None) -> str | None:
    value = _pick_value(source, keys, debug_hits)
    return _normalize_string(value)


def _pick_value(source: dict[str, Any], keys: list[str], debug_hits: list[str] | None) -> Any:
    if not isinstance(source, dict):
        return None
    key_map = {_normalize_prop_key(str(k)): k for k in source.keys()}
    for key in keys:
        original = key_map.get(_normalize_prop_key(key))
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


def _normalize_quantity(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        q = float(value)
        return q if q > 0 else None
    text = str(value).strip().replace(",", ".").replace("\u202f", "").replace("\xa0", "")
    if text.startswith("+"):
        text = text[1:]
    if not text:
        return None
    try:
        q = float(text)
        return q if q > 0 else None
    except ValueError:
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
