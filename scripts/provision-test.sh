#!/usr/bin/env bash
#
# Walks the device first contact flow by hand, the way firmware will (dynsec-broker-summary.md).
#
#   Stage 1  connect to the broker as the shared `announce` user and read the retained
#            con/endpoint message, exactly as a device with no credentials does
#   Stage 2  POST a hardware id to the provisioning URL from that message
#   Stage 3  if credentials come back, log in to the broker as that device and subscribe to its
#            own command topic
#
# Stage 3 needs a model string that a device type on the server lists; otherwise stage 2 ends with
# a 400, which is still a correct pass for stages 1 and 2.
#
# Needs: mosquitto_sub (mosquitto-clients), curl, python3.
#   Ubuntu: apt install mosquitto-clients
#   macOS:  brew install mosquitto
#
# Usage:
#   ANNOUNCE_PASSWORD=... scripts/provision-test.sh --broker app.voltastc.com --mac 020000000001 --model M
#
set -u -o pipefail

BROKER=""
PORT="8883"
MAC=""
MODEL="gw-cell-1"
FW="0.0.0-test"
ANNOUNCE_USER="announce"
CAFILE=""
INSECURE="0"
URL=""

usage()
{
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    cat <<'USAGE'

Options:
  --broker HOST       broker host name (required unless --url is given)
  --port N            broker port, default 8883
  --mac MAC           hardware id to provision, required
  --model NAME        model string sent with the request, default gw-cell-1 (must be listed in a
                      device type module's models, or the server refuses it)
  --fw VERSION        firmware string sent with the request, default 0.0.0-test
  --announce-user U   broker user for first contact, default announce
  --cafile PATH       CA bundle for broker TLS
  --insecure          skip broker TLS verification, development only
  --url URL           skip stage 1 and post straight to this provisioning URL
  -h, --help          this text

Environment:
  ANNOUNCE_PASSWORD   password for the announce user, required unless --url is given
USAGE
}

while [ $# -gt 0 ]
do
    case "$1" in
        --broker) BROKER="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --mac) MAC="$2"; shift 2 ;;
        --model) MODEL="$2"; shift 2 ;;
        --fw) FW="$2"; shift 2 ;;
        --announce-user) ANNOUNCE_USER="$2"; shift 2 ;;
        --cafile) CAFILE="$2"; shift 2 ;;
        --insecure) INSECURE="1"; shift ;;
        --url) URL="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

for tool in curl python3
do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 2; }
done

[ -n "$MAC" ] || { echo "--mac is required" >&2; exit 2; }

say()
{
    printf '\n== %s\n' "$1"
}

# Reads one top level key out of a JSON document on stdin. Prints nothing when absent.
json_get()
{
    python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
v = d.get(sys.argv[1]) if isinstance(d, dict) else None
if v is not None:
    print(v)
' "$1"
}

# ---------------------------------------------------------------- stage 1
if [ -z "$URL" ]
then
    command -v mosquitto_sub >/dev/null 2>&1 || { echo "missing mosquitto_sub; install mosquitto-clients, or pass --url" >&2; exit 2; }
    [ -n "$BROKER" ] || { echo "--broker is required unless --url is given" >&2; exit 2; }
    [ -n "${ANNOUNCE_PASSWORD:-}" ] || { echo "set ANNOUNCE_PASSWORD, or pass --url" >&2; exit 2; }

    say "Stage 1: read retained con/endpoint as '$ANNOUNCE_USER' from $BROKER:$PORT"
    TLS_ARGS=()
    if [ "$INSECURE" = "1" ]
    then
        TLS_ARGS+=(--insecure)
    fi
    if [ -n "$CAFILE" ]
    then
        TLS_ARGS+=(--cafile "$CAFILE")
    elif [ "$PORT" = "8883" ] && [ "$INSECURE" != "1" ]
    then
        for candidate in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /opt/homebrew/etc/openssl@3/cert.pem /usr/local/etc/openssl@3/cert.pem
        do
            if [ -f "$candidate" ]
            then
                TLS_ARGS+=(--cafile "$candidate")
                echo "using CA bundle $candidate"
                break
            fi
        done
    fi

    RETAINED="$(mosquitto_sub -h "$BROKER" -p "$PORT" -u "$ANNOUNCE_USER" -P "$ANNOUNCE_PASSWORD" \
        -t con/endpoint -C 1 -W 5 -q 1 "${TLS_ARGS[@]}" 2>&1)"
    RC=$?
    if [ $RC -ne 0 ] || [ -z "$RETAINED" ]
    then
        echo "FAIL: no retained message (exit $RC)"
        echo "$RETAINED"
        echo "Check: is the leader running and connected, and can '$ANNOUNCE_USER' read con/endpoint?"
        exit 1
    fi
    echo "payload: $RETAINED"

    URL="$(printf '%s' "$RETAINED" | json_get url)"
    PUBLISHED="$(printf '%s' "$RETAINED" | json_get published)"
    [ -n "$URL" ] || { echo "FAIL: no 'url' in the retained payload"; exit 1; }
    echo "url:       $URL"
    if [ -n "$PUBLISHED" ]
    then
        python3 -c '
import datetime, sys
try:
    t = datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
except ValueError:
    print("published: " + sys.argv[1] + " (unrecognised format)"); raise SystemExit(0)
age = (datetime.datetime.now(datetime.timezone.utc) - t).total_seconds()
note = "stale, no leader has published in over a day" if age > 90000 else "current"
print("published: %s (%.0f s ago, %s)" % (sys.argv[1], age, note))
' "$PUBLISHED"
    else
        echo "published: absent (older build, or a message published by hand)"
    fi
    echo "PASS stage 1"
fi

# ---------------------------------------------------------------- stage 2
say "Stage 2: POST hardware id $MAC to $URL"
BODY_FILE="$(mktemp)"
HDR_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE" "$HDR_FILE"' EXIT

REQUEST="$(python3 -c '
import json, sys
print(json.dumps({"hw": sys.argv[1], "model": sys.argv[2], "fw": sys.argv[3]}))
' "$MAC" "$MODEL" "$FW")"
echo "request:  $REQUEST"

HTTP_CODE="$(curl -sS -o "$BODY_FILE" -D "$HDR_FILE" -w '%{http_code}' \
    -X POST -H 'content-type: application/json' -d "$REQUEST" "$URL")"
CURL_RC=$?
if [ $CURL_RC -ne 0 ]
then
    echo "FAIL: request failed (curl exit $CURL_RC)"
    exit 1
fi

RATE_REMAINING="$(tr -d '\r' < "$HDR_FILE" | awk 'tolower($1) == "x-ratelimit-remaining:" { print $2 }')"
echo "http:     $HTTP_CODE"
[ -n "$RATE_REMAINING" ] && echo "rate:     $RATE_REMAINING requests left this minute"
echo "response: $(cat "$BODY_FILE")"

GUID="$(json_get guid < "$BODY_FILE")"
PASSWORD="$(json_get password < "$BODY_FILE")"

case "$HTTP_CODE" in
    200)
        EXISTING="$(json_get existing < "$BODY_FILE")"
        if [ -n "$GUID" ] && [ -n "$PASSWORD" ]
        then
            echo "PASS stage 2: credentials issued for $GUID"
        elif [ -n "$GUID" ] && [ "$EXISTING" = "True" ]
        then
            echo "PASS stage 2: this unit already holds active credentials for $GUID"
            echo "      and was told to keep them; no password is re-sent. To get a fresh one,"
            echo "      use Reprovision, then run this again."
        else
            echo "FAIL stage 2: accepted but the body has neither a password nor existing:true"
            exit 1
        fi
        ;;
    409)
        echo "RETRY stage 2: another request is issuing this unit's account right now. Run again in"
        echo "      a few seconds."
        ;;
    503)
        echo "PASS stage 2 (as built): the endpoint answered, issuing is not implemented yet"
        ;;
    429)
        echo "NOTE: rate limited. That is the limiter working; wait for the next minute."
        ;;
    400)
        echo "FAIL stage 2: the endpoint rejected the request body"
        exit 1
        ;;
    404)
        echo "REFUSED stage 2: this hardware id is not eligible. Unknown hardware and a device that is"
        echo "      already active get the same answer on purpose, so check which it is:"
        echo "      - unknown: it is now on Admin > Unknown devices (DTM_device_registry, last_device_uid"
        echo "        NULL). Claim it into a location, then run this again."
        echo "      - already active: use Reprovision on the device's Settings tab, then run this again."
        exit 1
        ;;
    401)
        echo "FAIL stage 2: 'Missing bearer token' means this URL reached the bearer only API router,"
        echo "      not the provisioning router. A device on first contact has no key, so it can never"
        echo "      get past that. The URL should be <host>/provision/v1, not <host>/api/v1/..."
        echo "      If it came from the retained message, that message is stale: deploy, let the leader"
        echo "      reconnect, and it republishes con/endpoint with the right URL and a fresh date."
        exit 1
        ;;
    *)
        echo "NOTE: unexpected app status ${HTTP_CODE}. Not a failure on its own; read the body above."
        ;;
esac

# ---------------------------------------------------------------- stage 3
say "Stage 3: log in to the broker as the provisioned device"
if [ -z "$GUID" ] || [ -z "$PASSWORD" ]
then
    echo "SKIP: no credentials were issued, so there is nothing to log in with."
    exit 0
fi
if ! command -v mosquitto_sub >/dev/null 2>&1
then
    echo "SKIP: mosquitto_sub not installed."
    exit 0
fi

echo "user:     $GUID"
OUT="$(mosquitto_sub -h "$BROKER" -p "$PORT" -u "$GUID" -P "$PASSWORD" \
    -t "dev/$GUID/cmd/#" -C 1 -W 5 -q 1 "${TLS_ARGS[@]}" 2>&1)"
RC=$?
# Exit 27 is mosquitto_sub's "no message before -W elapsed", which is the expected result: the login
# and the subscribe both succeeded and nothing was waiting on the command topic.
if [ $RC -eq 0 ] || [ $RC -eq 27 ]
then
    echo "PASS stage 3: connected and subscribed to dev/$GUID/cmd/#"
    echo
    echo "Not proven by this test: that the device can RECEIVE on that topic. The broker defaults"
    echo "publishClientReceive to deny, so a role without an explicit receive ACL subscribes fine and"
    echo "is then delivered nothing. To check, publish to dev/$GUID/cmd/test as the server while this"
    echo "subscription is open and confirm it arrives."
    exit 0
fi
echo "FAIL stage 3: could not connect or subscribe (exit $RC)"
echo "$OUT"
exit 1
