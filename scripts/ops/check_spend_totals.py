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


PERSONAL_QUERY = """
WITH d AS(SELECT user_id,month,sum(charged_tokens) used_tokens,sum(CASE WHEN settled=0 THEN charged_tokens ELSE 0 END) reserved_tokens,count(*) requests,sum(prompt_tokens) prompt_tokens,sum(completion_tokens) completion_tokens FROM luna_usage GROUP BY user_id,month),
errors AS(
 SELECT d.user_id FROM d LEFT JOIN luna_user_month_totals t USING(user_id,month) WHERE t.user_id IS NULL OR d.used_tokens<>t.used_tokens OR d.reserved_tokens<>t.reserved_tokens OR d.requests<>t.requests OR d.prompt_tokens<>t.prompt_tokens OR d.completion_tokens<>t.completion_tokens
 UNION ALL SELECT t.user_id FROM luna_user_month_totals t LEFT JOIN d USING(user_id,month) WHERE d.user_id IS NULL AND (t.used_tokens<>0 OR t.reserved_tokens<>0 OR t.requests<>0 OR t.prompt_tokens<>0 OR t.completion_tokens<>0))
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
            QUERY.strip().rstrip(";") + ";" + PERSONAL_QUERY,
            "--json",
            "--config",
            "cloudflare/wrangler.jsonc",
        ],
        cwd=ROOT,
        text=True,
    )
    rows = json.loads(output)
    if len(rows) != 2 or any(row["results"][0]["mismatches"] for row in rows):
        raise SystemExit(
            "Spend totals differ from ledger; no automatic correction was made"
        )
    print("Global spend and personal cloud token totals match detailed ledgers.")


if __name__ == "__main__":
    main()
