"""Retire only the two obsolete voice CNAMEs; preserve active API/account records."""

import base64
import datetime
import json
import os
import re
from pathlib import Path
import httpx

ROOT = Path(__file__).resolve().parents[2]
os.umask(0o077)
cert = (Path.home() / ".cloudflared/cert.pem").read_text()
body = re.search(
    r"-----BEGIN ARGO TUNNEL TOKEN-----\s*(.*?)\s*-----END ARGO TUNNEL TOKEN-----",
    cert,
    re.S,
).group(1)
auth = json.loads(base64.b64decode(body))
zone = auth["zoneID"]
with httpx.Client(
    base_url="https://api.cloudflare.com/client/v4",
    headers={"Authorization": "Bearer " + auth["apiToken"]},
    timeout=30,
    trust_env=False,
) as c:

    def records(name):
        r = c.get(
            "/zones/" + zone + "/dns_records", params={"name": name, "per_page": 100}
        )
        r.raise_for_status()
        d = r.json()
        if not d.get("success"):
            raise RuntimeError("DNS query failed")
        return d["result"]

    protected = {
        name: records(name)
        for name in ["api.sunlingzhang.com", "accounts.sunlingzhang.com"]
    }
    retired = {
        name: records(name) for name in ["asr.sunlingzhang.com", "tts.sunlingzhang.com"]
    }
    for name, rows in retired.items():
        for row in rows:
            if (
                row["name"] != name
                or row["type"] != "CNAME"
                or row["content"]
                != "c25403d1-b154-458c-95f5-e82be86be9b7.cfargotunnel.com"
            ):
                raise RuntimeError("Unexpected old record; refusing broad deletion")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = ROOT / "deploy/backups" / ("voice-dns-" + stamp + ".json")
    backup.parent.mkdir(exist_ok=True, parents=True)
    backup.write_text(
        json.dumps({"retired": retired, "protected": protected}, indent=2) + "\n"
    )
    backup.chmod(0o600)
    deleted = []
    for name, rows in retired.items():
        for row in rows:
            r = c.delete("/zones/" + zone + "/dns_records/" + row["id"])
            r.raise_for_status()
            if not r.json().get("success"):
                raise RuntimeError("DNS deletion failed")
            deleted.append(name)
    for name in retired:
        assert not records(name), "Old DNS record still present"

    # Compare the operational fields, excluding API-generated timestamps.
    def signature(rows):
        return sorted(
            (r["id"], r["type"], r["name"], r["content"], r["ttl"], r["proxied"])
            for r in rows
        )

    for name, rows in protected.items():
        assert signature(rows) == signature(records(name)), "Protected record changed"
    z = c.get("/zones/" + zone)
    z.raise_for_status()
    nameservers = z.json().get("result", {}).get("name_servers", [])
    result = {
        "deleted_records": deleted,
        "old_records_absent": True,
        "api_and_accounts_unchanged": True,
        "backup": str(backup),
        "authoritative_nameservers": nameservers,
    }
    (ROOT / "artifacts/voice-dns-retirement.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    print(json.dumps(result, indent=2))
