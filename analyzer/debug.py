from __future__ import annotations

from typing import Any, Iterable


def debug_entity(entity: Any, psets: dict[str, Any], hit_keys: Iterable[str]) -> None:
    pset_names = sorted(psets.keys())
    print(
        "[DEBUG] entity",
        {
            "expressID": _entity_id(entity),
            "ifcType": entity.is_a(),
            "psets": pset_names,
            "keysFound": sorted(set(hit_keys)),
        },
    )


def _entity_id(entity: Any) -> int | None:
    try:
        return entity.id()
    except Exception:
        return None
