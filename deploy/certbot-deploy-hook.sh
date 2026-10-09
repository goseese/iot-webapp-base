#!/bin/sh
# certbot deploy hook, installed by deploy/install.sh as
# /etc/letsencrypt/renewal-hooks/deploy/<slug>.sh (__DOMAIN__ replaced with the site's domain).
# certbot runs it after every successful renewal; install.sh also runs it once after the first
# issue. Copies the certificate to Mosquitto (8883 serves the same name as the web site) and
# reloads both servers. mosquitto reloads listener certificates on SIGHUP (2.0.22 src/loop.c:
# listeners__reload_all_certificates), so devices stay connected.
set -eu

DOMAIN="__DOMAIN__"
LIVE="/etc/letsencrypt/live/$DOMAIN"

# certbot sets RENEWED_LINEAGE; other certificates on this server are not ours.
if [ "${RENEWED_LINEAGE:-$LIVE}" != "$LIVE" ]
then
    exit 0
fi

install -o mosquitto -g mosquitto -m 600 "$LIVE/fullchain.pem" /etc/mosquitto/certs/fullchain.pem
install -o mosquitto -g mosquitto -m 600 "$LIVE/privkey.pem" /etc/mosquitto/certs/privkey.pem

if systemctl is-active --quiet mosquitto
then
    systemctl reload mosquitto
fi
if systemctl is-active --quiet nginx
then
    systemctl reload nginx
fi
