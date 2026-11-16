"""Validate private Alibaba SMTP credentials, then install Worker email secrets."""

import argparse
import json
import os
from pathlib import Path
import secrets
import smtplib
import ssl
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument(
        "--test-mail",
        action="store_true",
        help="Send one test only to the configured sender mailbox",
    )
    parser.add_argument(
        "--allow-legacy-enterprise",
        action="store_true",
        help="Explicit temporary fallback only; Alibaba enterprise mail does not support registration verification use",
    )
    args = parser.parse_args()
    os.umask(0o077)
    args.config.chmod(0o600)
    c = json.loads(args.config.read_text())
    allowed = {
        "smtp_host",
        "smtp_port",
        "smtp_secure",
        "smtp_username",
        "smtp_password",
        "from_email",
        "from_name",
        "provider",
    }
    if (
        set(c) - allowed
        or c.get("smtp_port") != 465
        or c.get("smtp_secure") is not True
        or not c.get("smtp_password")
        or c.get("smtp_username") != c.get("from_email")
    ):
        raise SystemExit(
            "Expected TLS SMTP port 465, sender matching username and a nonempty authorization code"
        )
    provider = c.get("provider") or (
        "legacy-enterprise"
        if "qiye.aliyun" in c.get("smtp_host", "")
        else "generic-smtp"
    )
    directmail_hosts = {
        "smtpdm.aliyun.com",
        "smtpdm-ap-southeast-1.aliyuncs.com",
        "smtpdm-us-east-1.aliyuncs.com",
        "smtpdm-eu-central-1.aliyuncs.com",
    }
    if provider not in {"legacy-enterprise", "generic-smtp", "alicloud-directmail"} or (
        provider == "alicloud-directmail" and c.get("smtp_host") not in directmail_hosts
    ):
        raise SystemExit("Invalid transactional SMTP provider or region endpoint")
    if (
        not args.check_only
        and provider == "legacy-enterprise"
        and not args.allow_legacy_enterprise
    ):
        raise SystemExit(
            "Enterprise mailbox is not a supported registration-mail service; supply transactional SMTP credentials"
        )
    c["provider"] = provider
    try:
        with smtplib.SMTP_SSL(
            c["smtp_host"], 465, timeout=20, context=ssl.create_default_context()
        ) as smtp:
            smtp.login(c["smtp_username"], c["smtp_password"])
            if args.test_mail:
                from email.message import EmailMessage

                message = EmailMessage()
                message["From"] = c["from_email"]
                message["To"] = c["from_email"]
                message["Subject"] = "Helix AI SMTP configuration test"
                message.set_content(
                    "SMTP configuration verification. No registration code is included."
                )
                smtp.send_message(message)
    except Exception as exc:
        # Never print SMTP peer replies: they may contain mailbox identifiers.
        raise SystemExit("SMTP verification failed: " + type(exc).__name__) from None
    print(
        "SMTP TLS and authentication verified."
        + (" Self-addressed test accepted." if args.test_mail else " No email sent.")
    )
    if args.check_only:
        return
    pepper_file = ROOT / ".runtime/email-code-secret"
    if not pepper_file.exists():
        fd = os.open(pepper_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(secrets.token_hex(32))
    pepper_file.chmod(0o600)
    pepper = pepper_file.read_text().strip()
    if len(pepper) < 32:
        raise SystemExit("Invalid private email-code-secret")
    env = os.environ.copy()
    node = Path.home() / ".local/tools/node/bin"
    if node.exists():
        env["PATH"] = str(node) + os.pathsep + env.get("PATH", "")
    subprocess.run(
        [str(ROOT / "cloudflare/node_modules/.bin/wrangler"), "secret", "bulk"],
        cwd=ROOT / "cloudflare",
        input=json.dumps(
            {"REGISTRATION_SMTP": json.dumps(c), "EMAIL_CODE_SECRET": pepper}
        ),
        text=True,
        check=True,
        env=env,
    )
    print(
        "Worker mail secrets installed. Enable EMAIL_VERIFICATION_ENABLED in the reviewed release after validation."
    )


if __name__ == "__main__":
    main()
