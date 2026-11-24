"""One-time UAT setup. Run as root on the UAT host with credentials on stdin."""

import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
from datetime import datetime, timezone


APP_ENV = Path("/opt/loyalty-shopify/.env")
BACKEND_ENV = Path("/opt/project-loyalty-backend/.env")
ROLE = "shopify_app"
SCHEMA = "shopify_sessions"


def fail(message: str) -> None:
    raise SystemExit(message)


if os.geteuid() != 0:
    fail("Run as root on the UAT host")

values = json.load(sys.stdin)
required = (
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET",
    "SCOPES",
    "SHOPIFY_LOYALTY_SERVICE_SECRET",
    "LOYALTY_ADMIN_SESSION_KEY",
)
if any(not isinstance(values.get(key), str) or not values[key] for key in required):
    fail("Missing required Shopify app settings")
if not re.fullmatch(r"[a-fA-F0-9]{64}", values["SHOPIFY_LOYALTY_SERVICE_SECRET"]):
    fail("Invalid service secret")
if not re.fullmatch(r"[a-fA-F0-9]{64}", values["LOYALTY_ADMIN_SESSION_KEY"]):
    fail("Invalid admin session key")
if APP_ENV.exists():
    fail("App environment already exists; refusing to overwrite it")
if not BACKEND_ENV.is_file():
    fail("Backend environment is missing")
backend_text = BACKEND_ENV.read_text(encoding="utf-8")
for key in ("SHOPIFY_LOYALTY_SERVICE_SECRET", "SHOPIFY_LOYALTY_APP_URL"):
    if re.search(rf"^{key}=", backend_text, flags=re.MULTILINE):
        fail(f"Backend already sets {key}; refusing to overwrite it")

password = secrets.token_hex(32)
sql = f"""
BEGIN;
CREATE ROLE {ROLE} LOGIN PASSWORD '{password}';
GRANT CONNECT ON DATABASE loyalty_backend TO {ROLE};
CREATE SCHEMA {SCHEMA} AUTHORIZATION {ROLE};
COMMIT;
"""
subprocess.run(
    ["runuser", "-u", "postgres", "--", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-d", "loyalty_backend"],
    input=sql,
    text=True,
    stdout=subprocess.DEVNULL,
    check=True,
)

app_values = {
    "NODE_ENV": "production",
    "SHOPIFY_API_KEY": values["SHOPIFY_API_KEY"],
    "SHOPIFY_API_SECRET": values["SHOPIFY_API_SECRET"],
    "SHOPIFY_APP_URL": "https://shopify.reglrs.ai",
    "SCOPES": values["SCOPES"],
    "DATABASE_URL": f"postgresql://{ROLE}:{password}@127.0.0.1:5432/loyalty_backend?schema={SCHEMA}",
    "LOYALTY_BACKEND_URL": "https://uat-be.reglrs.ai/api",
    "SHOPIFY_LOYALTY_SERVICE_SECRET": values["SHOPIFY_LOYALTY_SERVICE_SECRET"],
    "LOYALTY_ADMIN_SESSION_KEY": values["LOYALTY_ADMIN_SESSION_KEY"],
}
fd = os.open(APP_ENV, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as stream:
    for key, value in app_values.items():
        stream.write(f"{key}={json.dumps(value)}\n")

stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
backup = BACKEND_ENV.with_name(f".env.pre-shopify-{stamp}")
shutil.copy2(BACKEND_ENV, backup)
with BACKEND_ENV.open("a", encoding="utf-8") as stream:
    if backend_text and not backend_text.endswith("\n"):
        stream.write("\n")
    stream.write(f"SHOPIFY_LOYALTY_SERVICE_SECRET={values['SHOPIFY_LOYALTY_SERVICE_SECRET']}\n")
    stream.write("SHOPIFY_LOYALTY_APP_URL=https://shopify.reglrs.ai\n")
print("Created isolated session schema and app environment; updated backend environment")
