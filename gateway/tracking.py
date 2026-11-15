"""Bounded ASCII correlation identifiers; never accept credentials as metadata."""

import re

_PATTERN = re.compile(r"^[A-Za-z0-9._:/-]{1,128}$")


def safe_id(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if _PATTERN.fullmatch(value) else None
