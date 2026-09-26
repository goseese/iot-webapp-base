#!/usr/bin/env bash
# devmon: deploy/README.md and .env.example point at Admin > Site settings > MQTT instead of .env.
# Run from the repo root. Safe to run twice.
set -euo pipefail

if [ ! -f deploy/README.md ] || [ ! -f .env.example ]
then
    echo "Run this from the repo root (DataTelematics.io)."
    exit 1
fi

python3 - << '__DEVMON_PY__'
import sys

README_OLD = '''`MQTT_HOST=iot.datatelematics.io`, `MQTT_PORT=8883`,
   `MQTT_TLS=true`, `MQTT_CLIENT_ID=server-devmon.datatelematics.io`, fresh'''
README_NEW = '''no MQTT keys (those are set after first login
   on Admin > Site settings > MQTT: host `iot.datatelematics.io`, port 8883, TLS on, user `devmon_server`,
   client id `server-devmon.datatelematics.io`), fresh'''

EXAMPLE_OLD = '''# MQTT_HOST=
'''
EXAMPLE_NEW = '''# MQTT is set on Admin > Site settings > MQTT, not here. A key set here overrides that page and makes it read only.
# MQTT_HOST=
'''

def edit(path, marker, old, new):
    with open(path, "r", newline="") as f:
        text = f.read()
    crlf = "\r\n" in text
    o = old.replace("\n", "\r\n") if crlf else old
    n = new.replace("\n", "\r\n") if crlf else new
    if marker in text:
        print("  already  " + path); return
    if text.count(o) != 1:
        print("  WARNING " + path + " does not match the expected text; edit by hand"); return
    with open(path, "w", newline="") as f:
        f.write(text.replace(o, n))
    print("  edited   " + path)

edit("deploy/README.md", "Admin > Site settings > MQTT", README_OLD, README_NEW)
edit(".env.example", "Admin > Site settings > MQTT", EXAMPLE_OLD, EXAMPLE_NEW)
__DEVMON_PY__

echo
echo "Review with: git diff deploy/README.md .env.example"
