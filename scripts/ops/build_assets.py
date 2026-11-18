"""Build public, content-addressed portal assets; never copy private runtime files."""

import hashlib
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[2]
FILES = (
    "captcha.js",
    "email-verification.js",
    "captcha-page.js",
    "password-reset.js",
    "app.js",
    "portal-common.js",
    "admin-portal.js",
    "notice-manager.js",
    "admin.js",
    "notices.js",
    "style.css",
)
CSP = "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"


def build(destination=None):
    source = ROOT / "accounts/static"
    output = destination or ROOT / ".runtime/portal-assets"
    if output.exists():
        shutil.rmtree(output)
    (output / "static").mkdir(parents=True)
    html = (source / "index.html").read_text()
    admin_html = (source / "admin.html").read_text()
    headers = [
        f"/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  Content-Security-Policy: {CSP}\n",
        "/\n  Cache-Control: no-store\n",
        "/index.html\n  Cache-Control: no-store\n",
    ]
    for name in FILES:
        content = (source / name).read_bytes()
        digest = hashlib.sha256(content).hexdigest()[:16]
        stem, suffix = name.rsplit(".", 1)
        versioned = f"{stem}.{digest}.{suffix}"
        (output / "static" / versioned).write_bytes(content)
        # Old cached HTML remains usable while fetching current unversioned scripts.
        (output / "static" / name).write_bytes(content)
        admin_html = admin_html.replace("/static/" + name, "/static/" + versioned)
        html = html.replace("/static/" + name, "/static/" + versioned)
        headers.extend(
            [
                f"/static/{versioned}\n  Cache-Control: public, max-age=31536000, immutable\n",
                f"/static/{name}\n  Cache-Control: no-store\n",
            ]
        )
    challenge = (source / "captcha.html").read_text()
    for name in FILES:
        content = (source / name).read_bytes()
        stem, suffix = name.rsplit(".", 1)
        versioned = stem + "." + hashlib.sha256(content).hexdigest()[:16] + "." + suffix
        challenge = challenge.replace("/static/" + name, "/static/" + versioned)
    (output / "captcha.html").write_text(challenge)
    (output / "index.html").write_text(html)
    (output / "admin").mkdir()
    (output / "admin/index.html").write_text(admin_html)
    headers.append("/admin*\n  Cache-Control: no-store\n")
    (output / "_headers").write_text("\n".join(headers))
    return output


if __name__ == "__main__":
    print("Public portal assets built: " + str(build()))
