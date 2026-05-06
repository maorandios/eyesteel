from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from analyzer import extract_model_data


def _ensure_utf8_stdio() -> None:
    """Avoid mojibake on Windows when piping JSON with Ø, ×, Hebrew, etc."""
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass


def main() -> None:
    _ensure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Run eyesteel IFC analyzer")
    parser.add_argument("ifc_file", type=str, help="Path to IFC file")
    parser.add_argument("--debug", action="store_true", help="Enable debug extraction output")
    parser.add_argument(
        "--out",
        type=str,
        default="",
        help="Optional path to save JSON output",
    )
    args = parser.parse_args()

    result = extract_model_data(args.ifc_file, debug=args.debug)
    data = json.dumps(result, ensure_ascii=False, indent=2)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(data, encoding="utf-8")
        print(f"Saved analyzer output to {out_path}")
    else:
        print(data)


if __name__ == "__main__":
    main()
