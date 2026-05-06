from __future__ import annotations

from dataclasses import dataclass
from typing import Any


SI_PREFIX_TO_FACTOR = {
    "EXA": 1e18,
    "PETA": 1e15,
    "TERA": 1e12,
    "GIGA": 1e9,
    "MEGA": 1e6,
    "KILO": 1e3,
    "HECTO": 1e2,
    "DECA": 1e1,
    "DECI": 1e-1,
    "CENTI": 1e-2,
    "MILLI": 1e-3,
    "MICRO": 1e-6,
    "NANO": 1e-9,
}


@dataclass
class UnitConverter:
    length_to_mm_factor: float = 1000.0  # IFC default SI meter -> mm
    mass_to_kg_factor: float = 1.0  # IFC default SI kilogram -> kg

    def to_mm(self, value: Any) -> float | None:
        number = _to_float(value)
        if number is None:
            return None
        return float(number * self.length_to_mm_factor)

    def to_kg(self, value: Any) -> float | None:
        number = _to_float(value)
        if number is None:
            return None
        return float(number * self.mass_to_kg_factor)


def build_unit_converter(model: Any) -> UnitConverter:
    converter = UnitConverter()
    projects = model.by_type("IfcProject")
    if not projects:
        return converter

    project = projects[0]
    units_in_context = getattr(project, "UnitsInContext", None)
    if not units_in_context:
        return converter

    for unit in getattr(units_in_context, "Units", []) or []:
        if not unit:
            continue
        unit_type = str(getattr(unit, "UnitType", "")).upper()
        if unit.is_a("IfcSIUnit"):
            if unit_type == "LENGTHUNIT":
                converter.length_to_mm_factor = _si_length_to_mm_factor(unit)
            elif unit_type == "MASSUNIT":
                converter.mass_to_kg_factor = _si_mass_to_kg_factor(unit)
        elif unit.is_a("IfcConversionBasedUnit"):
            if unit_type == "LENGTHUNIT":
                converter.length_to_mm_factor = _conversion_based_length_to_mm(unit)
            elif unit_type == "MASSUNIT":
                converter.mass_to_kg_factor = _conversion_based_mass_to_kg(unit)

    return converter


def _si_length_to_mm_factor(unit: Any) -> float:
    name = str(getattr(unit, "Name", "")).upper()
    prefix = str(getattr(unit, "Prefix", "")).upper()
    base = SI_PREFIX_TO_FACTOR.get(prefix, 1.0)
    # SI length base is meter; factor to meter then to mm.
    if name == "METRE":
        return base * 1000.0
    return base * 1000.0


def _si_mass_to_kg_factor(unit: Any) -> float:
    name = str(getattr(unit, "Name", "")).upper()
    prefix = str(getattr(unit, "Prefix", "")).upper()
    base = SI_PREFIX_TO_FACTOR.get(prefix, 1.0)
    # SI mass base in IFC is gram naming in some schemas; convert to kg.
    if name == "GRAM":
        return base * 0.001
    return base


def _conversion_based_length_to_mm(unit: Any) -> float:
    conversion = _conversion_to_si(unit)
    if conversion is None:
        return 1000.0
    return float(conversion * 1000.0)


def _conversion_based_mass_to_kg(unit: Any) -> float:
    conversion = _conversion_to_si(unit)
    if conversion is None:
        return 1.0
    return float(conversion)


def _conversion_to_si(unit: Any) -> float | None:
    component = getattr(unit, "ConversionFactor", None)
    if not component:
        return None
    value_component = getattr(component, "ValueComponent", None)
    if value_component is None:
        return None
    wrapped = getattr(value_component, "wrappedValue", value_component)
    return _to_float(wrapped)


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = value.strip().replace(",", "")
        if not cleaned:
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    wrapped = getattr(value, "wrappedValue", None)
    if wrapped is not None:
        return _to_float(wrapped)
    return None
