"""Read-only reconciliation of global quota totals against retained detailed ledgers."""

import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
QUERY = """
WITH l AS(SELECT month,sum(cost_nanos) cost_nanos,sum(CASE WHEN settled=0 THEN cost_nanos ELSE 0 END) reserved FROM luna_spend GROUP BY month),
a AS(SELECT day,kind,sum(units) units,sum(CASE WHEN settled=0 THEN units ELSE 0 END) reserved FROM audio_spend GROUP BY day,kind),
errors AS(
 SELECT 'luna' kind FROM l LEFT JOIN luna_spend_totals t USING(month) WHERE t.month IS NULL OR l.cost_nanos<>t.cost_nanos OR l.reserved<>t.reserved_cost_nanos
 UNION ALL SELECT 'luna' FROM luna_spend_totals t LEFT JOIN l USING(month) WHERE l.month IS NULL AND (t.cost_nanos<>0 OR t.reserved_cost_nanos<>0)
 UNION ALL SELECT 'audio' FROM a LEFT JOIN audio_spend_totals t USING(day,kind) WHERE t.day IS NULL OR a.units<>t.units OR a.reserved<>t.reserved_units
 UNION ALL SELECT 'audio' FROM audio_spend_totals t LEFT JOIN a USING(day,kind) WHERE a.day IS NULL AND (t.units<>0 OR t.reserved_units<>0))
SELECT count(*) mismatches FROM errors
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote", action="store_true", required=True)
    parser.parse_args()
    output = subprocess.check_output(
        [
            str(ROOT / "cloudflare/node_modules/.bin/wrangler"),
            "d1",
            "execute",
            "DB",
            "--remote",
            "--command",
            QUERY,
            "--json",
            "--config",
            "cloudflare/wrangler.jsonc",
        ],
        cwd=ROOT,
        text=True,
    )
    rows = json.loads(output)
    if not rows or rows[0]["results"][0]["mismatches"]:
        raise SystemExit(
            "Spend totals differ from ledger; no automatic correction was made"
        )
    print("Global Luna and audio totals match detailed ledgers.")


if __name__ == "__main__":
    main()
