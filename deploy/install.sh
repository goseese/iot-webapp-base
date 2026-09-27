#!/usr/bin/env bash
# Voltastc server installer for Ubuntu 26.04 LTS on EC2: nginx, Node 22 under pm2, Mosquitto, all on
# one server, with the database on RDS PostgreSQL. Safe to run again: every step checks first,
# secrets are generated once and kept, and a re-run reloads the app.
#
# Before the first run:
#   - DNS: an A record for app.voltastc.com pointing at this server's Elastic IP.
#   - EC2 security group inbound: 22 (your IP only), 80 and 443 (web and Let's Encrypt),
#     8883 (devices). 1883 and 3000 stay closed; they listen on 127.0.0.1 only.
#   - RDS PostgreSQL 15 or newer, reachable from this server on 5432. The first run asks for the
#     RDS endpoint, user and password; use the master user (the first migrate runs
#     CREATE EXTENSION citext, which needs rds_superuser).
#   - The code checked out by root at /opt/voltastc, for example with a read only deploy key in
#     /root/.ssh:  sudo git clone git@github.com:goseese/app.voltastc.git /opt/voltastc
#     package-lock.json must match package.json (npm ci refuses otherwise).
#
# Run:  sudo bash /opt/voltastc/deploy/install.sh
#
# Optional environment, for an unattended run or a test:
#   DOMAIN (app.voltastc.com)  LE_EMAIL (jeff@goseese.com)
#   CERTBOT_SERVER  ACME directory URL, e.g. Let's Encrypt staging
#                   https://acme-staging-v02.api.letsencrypt.org/directory
#   DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD  asked for when missing; used only on the first
#                   run, when .env is created
#
# Layout:
#   /opt/voltastc               code, owned by root (the app cannot change its own code)
#   /opt/voltastc/.env          root:voltastc 0640
#   /opt/voltastc/storage       report files, owned by voltastc
#   /opt/voltastc/storage/firmware/{volta-pod-ctl,volta-pod-target}/firmware.bin
#                               pod firmware, copied in by hand (services/firmware.js)
#   /opt/voltastc/certs         RDS CA bundle
#   /var/lib/voltastc           home of the voltastc system user; pm2 state and logs in .pm2
#   /etc/voltastc/broker.env    broker passwords, root only
set -Eeuo pipefail
# Any failing command stops the install; say which one, so it never ends quietly.
trap 'printf "\ninstall.sh: stopped at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

APP_USER=voltastc
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_HOME=/var/lib/voltastc
DOMAIN="${DOMAIN:-app.voltastc.com}"
LE_EMAIL="${LE_EMAIL:-jeff@goseese.com}"
NODE_MAJOR=22
PM2_VERSION=7.0.4
RDS_CA_URL=https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
ENV_FILE="$APP_DIR/.env"
CA_FILE="$APP_DIR/certs/rds-global-bundle.pem"
BROKER_ENV=/etc/voltastc/broker.env
DYNSEC_JSON=/var/lib/mosquitto/dynamic-security.json
WEBROOT=/var/www/letsencrypt
LIVE="/etc/letsencrypt/live/$DOMAIN"
HOOK=/etc/letsencrypt/renewal-hooks/deploy/voltastc.sh
PM2_UNIT="pm2-$APP_USER"
NEW_BROKER=0

step()
{
    printf '\n== %s\n' "$*"
}

die()
{
    printf '\ninstall.sh: %s\n' "$*" >&2
    exit 1
}

# Runs a command as the app user. runuser keeps the environment (so passwords never go on a
# command line, where ps can see them) and sets HOME to the app user's home.
as_app()
{
    runuser -u "$APP_USER" -- "$@"
}

# pm2 as the app user with a clean environment: pm2 hands the caller's environment to the apps it
# starts, and this shell may hold database or broker passwords.
pm2_app()
{
    as_app env -i HOME="$APP_HOME" PATH="$PATH" pm2 "$@"
}

# ask NAME "prompt" [default]: keeps NAME from the environment when set, otherwise prompts.
ask()
{
    local name="$1" prompt="$2" def="${3:-}" val="${!1:-}"
    while [ -z "$val" ]
    do
        read -r -p "$prompt${def:+ [$def]}: " val || die "no value for $name"
        val="${val:-$def}"
    done
    printf -v "$name" '%s' "$val"
}

ask_secret()
{
    local name="$1" prompt="$2" val="${!1:-}"
    while [ -z "$val" ]
    do
        read -r -s -p "$prompt: " val || die "no value for $name"
        printf '\n'
    done
    printf -v "$name" '%s' "$val"
}

node_ok()
{
    command -v npm >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" = "$NODE_MAJOR" ]
}

# Writes the nginx site from stdin. Drops the IPv6 listen lines when the kernel has IPv6 turned
# off, where nginx refuses to start with them.
write_site()
{
    if [ -e /proc/net/if_inet6 ]
    then
        cat > /etc/nginx/sites-available/voltastc
    else
        sed '/listen \[::\]/d' > /etc/nginx/sites-available/voltastc
    fi
    ln -sf /etc/nginx/sites-available/voltastc /etc/nginx/sites-enabled/voltastc
}

wait_for_port()
{
    local port="$1"
    for _ in $(seq 1 30)
    do
        if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
        then
            return 0
        fi
        sleep 1
    done
    return 1
}

# ---------------------------------------------------------------------------------------------
step "Checks"
[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash $0"
if [ ! -f "$APP_DIR/package.json" ] || [ ! -f "$APP_DIR/.env.example" ]
then
    die "$APP_DIR is not the app checkout"
fi
. /etc/os-release
if [ "${VERSION_ID:-}" != "26.04" ]
then
    echo "warning: written for Ubuntu 26.04, this is ${PRETTY_NAME:-unknown}"
fi
if [ "$(stat -c %U "$APP_DIR")" != "root" ]
then
    echo "warning: $APP_DIR is not owned by root; the app user should not be able to change its code"
fi
cd "$APP_DIR"
echo "app $APP_DIR, site $DOMAIN"

# ---------------------------------------------------------------------------------------------
step "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
# Ubuntu's own builds for everything but Node: mosquitto 2.0.22 (universe; the Mosquitto PPA has no
# 26.04 build), nginx, certbot. These take security updates from Ubuntu.
apt-get install -y -q nginx certbot mosquitto mosquitto-clients openssl curl gnupg git logrotate
# Node from NodeSource, configured the way their setup_22.x script does it. Ubuntu's own nodejs is
# 22 too, but its npm package pulls in about 380 more packages (eslint, webpack, babel); NodeSource's
# nodejs carries npm. unattended-upgrades does not update third party repositories: run
# `sudo apt-get update && sudo apt-get install nodejs` (or this script) for Node security releases.
NODESOURCE_LIST=/etc/apt/sources.list.d/nodesource.sources
if [ ! -f "$NODESOURCE_LIST" ] && ! node_ok
then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
    chmod 644 /usr/share/keyrings/nodesource.gpg
    printf 'Types: deb\nURIs: https://deb.nodesource.com/node_%s.x\nSuites: nodistro\nComponents: main\nArchitectures: %s\nSigned-By: /usr/share/keyrings/nodesource.gpg\n' \
        "$NODE_MAJOR" "$(dpkg --print-architecture)" > "$NODESOURCE_LIST"
    printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodejs
    apt-get update -q
fi
if [ -f "$NODESOURCE_LIST" ]
then
    apt-get install -y -q nodejs
fi
node_ok || die "Node $NODE_MAJOR with npm is required (package.json engines)"
echo "node $(node -v), npm $(npm -v), mosquitto $(dpkg-query -W -f='${Version}' mosquitto), nginx $(dpkg-query -W -f='${Version}' nginx)"
if [ "$(node -p "try { require('$(npm root -g)/pm2/package.json').version } catch (e) { '' }")" != "$PM2_VERSION" ]
then
    npm install -g --no-fund --no-audit "pm2@$PM2_VERSION"
fi

# ---------------------------------------------------------------------------------------------
step "App user and files"
if ! id "$APP_USER" >/dev/null 2>&1
then
    useradd --system --user-group --home-dir "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
as_app test -r "$APP_DIR/app.js" || die "the $APP_USER user cannot read $APP_DIR (clone with the default umask 022)"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR/storage"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR/storage/firmware" "$APP_DIR/storage/firmware/volta-pod-ctl" "$APP_DIR/storage/firmware/volta-pod-target"
install -d -m 755 "$APP_DIR/certs"
npm ci --omit=dev --no-fund --no-audit

# ---------------------------------------------------------------------------------------------
step ".env"
if [ ! -f "$ENV_FILE" ]
then
    ask DB_HOST "RDS endpoint"
    ask DB_PORT "RDS port" 5432
    ask DB_NAME "Database name" voltastc
    ask DB_USER "Database user (the RDS master user)"
    ask_secret DB_PASSWORD "Database password"
    case "$DB_PASSWORD" in
        *"'"*|*$'\n'*) die "the database password must not contain ' or a line break" ;;
    esac
    declare -A VALS=(
        [APP_URL]="https://$DOMAIN"
        [SESSION_SECRET]="$(openssl rand -hex 32)"
        [SETTINGS_KEY]="$(openssl rand -hex 32)"
        [DB_HOST]="$DB_HOST"
        [DB_PORT]="$DB_PORT"
        [DB_NAME]="$DB_NAME"
        [DB_USER]="$DB_USER"
        [DB_PASSWORD]="'$DB_PASSWORD'"
        [DB_SSL]=true
        [DB_SSL_CA]="$CA_FILE"
    )
    tmp="$(mktemp)"
    while IFS= read -r line || [ -n "$line" ]
    do
        key="${line%%=*}"
        if [[ "$line" == *=* && "$line" != \#* && -v "VALS[$key]" ]]
        then
            printf '%s=%s\n' "$key" "${VALS[$key]}"
        else
            printf '%s\n' "$line"
        fi
    done < "$APP_DIR/.env.example" > "$tmp"
    install -o root -g "$APP_USER" -m 640 "$tmp" "$ENV_FILE"
    rm -f "$tmp"
    echo "created $ENV_FILE (new SESSION_SECRET and SETTINGS_KEY; never rotate SETTINGS_KEY)"
else
    echo "$ENV_FILE exists, kept as is"
fi
if [ ! -s "$CA_FILE" ]
then
    curl -fsSL --retry 3 -o "$CA_FILE.tmp" "$RDS_CA_URL"
    mv "$CA_FILE.tmp" "$CA_FILE"
    chmod 644 "$CA_FILE"
    echo "downloaded the RDS CA bundle to $CA_FILE"
fi

# ---------------------------------------------------------------------------------------------
step "nginx and the Let's Encrypt certificate"
install -d -m 755 "$WEBROOT"
rm -f /etc/nginx/sites-enabled/default
if [ ! -f "$LIVE/fullchain.pem" ]
then
    # Port 80 only until the certificate exists; the full site refers to the certificate files.
    write_site <<EOF
server
{
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/
    {
        root $WEBROOT;
    }

    location /
    {
        return 404;
    }
}
EOF
    nginx -t -q
    systemctl enable nginx >/dev/null 2>&1
    systemctl reload-or-restart nginx
    certbot_extra=()
    if [ -n "${CERTBOT_SERVER:-}" ]
    then
        certbot_extra=(--server "$CERTBOT_SERVER")
    fi
    certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" -m "$LE_EMAIL" --agree-tos --no-eff-email \
        --non-interactive "${certbot_extra[@]}" \
        || die "certbot failed: check that $DOMAIN resolves to this server and port 80 is open in the security group"
fi
sed "s|__DOMAIN__|$DOMAIN|g" deploy/nginx/voltastc.conf | write_site
nginx -t -q
systemctl enable nginx >/dev/null 2>&1
systemctl reload-or-restart nginx
install -d -m 755 "$(dirname "$HOOK")"
sed "s|__DOMAIN__|$DOMAIN|g" deploy/certbot-deploy-hook.sh > "$HOOK"
chmod 755 "$HOOK"
systemctl enable --now certbot.timer >/dev/null 2>&1 || echo "warning: could not enable certbot.timer (renewals)"
echo "certificate $LIVE, renewal hook $HOOK"

# ---------------------------------------------------------------------------------------------
step "Mosquitto"
PLUGIN="$(dpkg -L mosquitto | grep '/mosquitto_dynamic_security\.so$')" || die "the mosquitto package has no dynamic security plugin"
install -d -m 700 "$(dirname "$BROKER_ENV")"
if [ ! -f "$BROKER_ENV" ]
then
    (
        umask 077
        printf 'BROKER_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'BROKER_SERVER_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'BROKER_DYNSEC_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'BROKER_ANNOUNCE_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    ) > "$BROKER_ENV.tmp"
    chmod 600 "$BROKER_ENV.tmp"
    mv "$BROKER_ENV.tmp" "$BROKER_ENV"
    NEW_BROKER=1
fi
if [ ! -f "$DYNSEC_JSON" ]
then
    # mosquitto 2.0 does not create this file itself. mosquitto_ctrl reads the password twice from
    # stdin (printf is a shell builtin, so it never appears in ps).
    systemctl stop mosquitto
    # shellcheck source=/dev/null
    admin_pw="$(. "$BROKER_ENV"; printf '%s' "$BROKER_ADMIN_PASSWORD")"
    printf '%s\n%s\n' "$admin_pw" "$admin_pw" | mosquitto_ctrl dynsec init "$DYNSEC_JSON" admin > /dev/null
    unset admin_pw
    chown mosquitto:mosquitto "$DYNSEC_JSON"
    chmod 600 "$DYNSEC_JSON"
    echo "created $DYNSEC_JSON with the admin client"
fi
sed "s|__DYNSEC_PLUGIN__|$PLUGIN|" deploy/mosquitto/voltastc.conf > /etc/mosquitto/conf.d/voltastc.conf
# Ubuntu 26.04's apparmor package confines mosquitto (/etc/apparmor.d/mosquitto) to mosquitto.db in
# /var/lib/mosquitto, so the dynamic security plugin cannot read its config ("File is not readable")
# and every login is refused. The profile's local include is the supported place for additions.
# The plugin rewrites the file as .new and renames it, the same pattern the profile allows for
# mosquitto.db.
if [ -f /etc/apparmor.d/mosquitto ]
then
    printf '%s\n' "# Voltastc, written by deploy/install.sh: the dynamic security plugin config" \
        "/var/lib/mosquitto/dynamic-security.json rwk," \
        "/var/lib/mosquitto/dynamic-security.json.new rwk," > /etc/apparmor.d/local/mosquitto
    if aa-enabled --quiet 2>/dev/null
    then
        apparmor_parser -r /etc/apparmor.d/mosquitto
        echo "AppArmor: mosquitto may use $DYNSEC_JSON"
    fi
fi
"$HOOK"
systemctl enable mosquitto >/dev/null 2>&1
systemctl restart mosquitto
wait_for_port 1883 || die "mosquitto did not start; see /var/log/mosquitto/mosquitto.log"
wait_for_port 8883 || die "mosquitto is not listening on 8883; see /var/log/mosquitto/mosquitto.log"

# ---------------------------------------------------------------------------------------------
step "Database"
as_app node scripts/create-db.js
as_app node scripts/migrate.js
as_app node scripts/seed.js

# ---------------------------------------------------------------------------------------------
step "Broker users and MQTT site settings"
(
    set -a
    # shellcheck source=/dev/null
    . "$BROKER_ENV"
    set +a
    as_app node scripts/broker-bootstrap.js --settings
)

# ---------------------------------------------------------------------------------------------
step "pm2"
cat > /etc/logrotate.d/voltastc <<EOF
$APP_HOME/.pm2/logs/*.log
{
    su $APP_USER $APP_USER
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
if [ ! -f "/etc/systemd/system/$PM2_UNIT.service" ]
then
    env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME"
fi
# The pm2 daemon always runs under systemd; the commands below talk to it. On the very first start
# pm2 reports that no process list was saved yet; that is expected.
systemctl start "$PM2_UNIT"
pm2_app startOrReload ecosystem.config.js
pm2_app save

# ---------------------------------------------------------------------------------------------
step "Health"
ok=0
for _ in $(seq 1 30)
do
    if curl -fs -o /dev/null http://127.0.0.1:3000/health
    then
        ok=1
        break
    fi
    sleep 1
done
if [ "$ok" = 1 ]
then
    echo "app: $(curl -sS http://127.0.0.1:3000/health)"
else
    echo "warning: http://127.0.0.1:3000/health did not answer; see: cd $APP_DIR && sudo runuser -u $APP_USER -- pm2 logs"
fi
if curl -fs -o /dev/null --max-time 10 "https://$DOMAIN/health"
then
    echo "https://$DOMAIN/health answers"
else
    echo "warning: https://$DOMAIN/health did not answer from this server (DNS, security group, or no hairpin)"
fi
pm2_app list

# ---------------------------------------------------------------------------------------------
step "Done"
if [ "$NEW_BROKER" = 1 ]
then
    (
        # shellcheck source=/dev/null
        . "$BROKER_ENV"
        echo "New broker passwords (kept root only in $BROKER_ENV):"
        echo "  admin     $BROKER_ADMIN_PASSWORD   (people only, full broker access)"
        echo "  announce  $BROKER_ANNOUNCE_PASSWORD   (goes into every pod firmware image)"
    )
fi
echo "Superadmin: the first run of seed.js above printed the sign in name and one time password."
echo "Site: https://$DOMAIN   Devices: mqtts://$DOMAIN:8883"
echo "EC2 security group inbound: 22 (your IP), 80, 443, 8883."
# Email (SES) takes its AWS credentials from the EC2 instance role; say whether one is attached.
# Setup steps: DECISIONS.md, "SES on the server".
IMDS_TOKEN="$(curl -fs --max-time 2 -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)"
ROLE="$(curl -fs --max-time 2 -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/iam/security-credentials/ || true)"
if [ -n "$ROLE" ]
then
    echo "Email: instance role $ROLE is attached (it needs ses:SendEmail on Resource \"*\")."
else
    echo "Email: no EC2 instance role attached, so SES cannot send. See DECISIONS.md, \"SES on the server\"."
fi
