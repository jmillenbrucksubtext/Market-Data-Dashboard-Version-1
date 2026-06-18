"""Generate static shadow-market JSON assets for dashboard markets."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

try:
    from .engine import analyze
except ImportError:
    from engine import analyze


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = Path(__file__).with_name("markets.json")
DEFAULT_OUTPUT_DIR = ROOT / "assets" / "shadow-market"


def load_configs() -> dict[str, dict]:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def generate_market(
    market_key: str,
    config: dict,
    year: int,
    output_dir: Path,
) -> Path:
    result = analyze(config, year)
    core_payload = {
        "market_key": int(market_key),
        "school_key": config["school_key"],
        "market_name": config["name"],
        "anchor_university": config["anchor_university"],
        **result,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{market_key}.json"
    if output_path.exists():
        existing = json.loads(output_path.read_text(encoding="utf-8"))
        existing_core = {
            key: value
            for key, value in existing.items()
            if key != "generated_at"
        }
        if existing_core == core_payload:
            return output_path
    payload = {
        **core_payload,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    output_path.write_text(
        json.dumps(payload, indent=2, sort_keys=False),
        encoding="utf-8",
    )
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--market-key",
        action="append",
        help="Dashboard market_key to generate. Repeat for multiple markets.",
    )
    parser.add_argument("--year", type=int, help="Override configured ACS year.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
    )
    args = parser.parse_args()

    configs = load_configs()
    requested = args.market_key or sorted(configs, key=int)
    for market_key in requested:
        if market_key not in configs:
            raise SystemExit(f"Unknown market_key: {market_key}")
        config = configs[market_key]
        year = args.year or max(config["years"])
        if year not in config["years"]:
            raise SystemExit(
                f"Year {year} is not configured for market_key {market_key}"
            )
        output_path = generate_market(
            market_key,
            config,
            year,
            args.output_dir,
        )
        print(f"generated {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
