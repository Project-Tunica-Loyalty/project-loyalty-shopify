"""Switch the UAT app container to another Shopify app without printing secrets."""

import json
import os
from pathlib import Path
import re
import shutil
import sys
from datetime import datetime, timezone


ENV_PATH = Path("/opt/loyalty-shopify/.env")
EXPECTED_KEY = "0814c471da200f7ce2a71ac98eed7d4b"

if os.geteuid() != 0 or not ENV_PATH.is_file():
    raise SystemExit("Run as root on the UAT app host")

values = json.load(sys.stdin)
if values.get("SHOPIFY_API_KEY") != EXPECTED_KEY:
    raise SystemExit("Unexpected Shopify app key")
if not isinstance(values.get("SHOPIFY_API_SECRET"), str) or not values["SHOPIFY_API_SECRET"]:
    raise SystemExit("Missing Shopify app secret")
if not isinstance(values.get("SCOPES"), str) or not values["SCOPES"]:
    raise SystemExit("Missing Shopify scopes")

original = ENV_PATH.read_text(encoding="utf-8")
updated = original
for key in ("SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SCOPES"):
    if len(re.findall(rf"^{key}=", updated, flags=re.MULTILINE)) != 1:
        raise SystemExit(f"Expected exactly one {key} entry")
    line = f"{key}={json.dumps(values[key])}"
    updated = re.sub(rf"^{key}=.*$", lambda _match: line, updated, count=1, flags=re.MULTILINE)

stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
backup = ENV_PATH.with_name(f".env.pre-new-app-{stamp}")
shutil.copy2(ENV_PATH, backup)
temporary = ENV_PATH.with_name(".env.new-app.tmp")
fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as stream:
    stream.write(updated)
os.replace(temporary, ENV_PATH)
print("UAT app credentials updated; previous environment backed up")
