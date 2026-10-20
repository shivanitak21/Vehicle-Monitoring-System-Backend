#!/bin/sh
set -eu
mkdir -p /mosquitto/config /mosquitto/data /mosquitto/log
cp /opt/source/mosquitto.conf /mosquitto/config/mosquitto.conf
cp /opt/source/acl /mosquitto/config/acl
PASS=/mosquitto/config/passwd
rm -f "$PASS"
touch "$PASS"
mosquitto_passwd -b "$PASS" "${MQTT_BACKEND_USERNAME}" "${MQTT_BACKEND_PASSWORD}"
mosquitto_passwd -b "$PASS" "${MQTT_DEVICE_USERNAME}" "${MQTT_DEVICE_PASSWORD}"
chown -R mosquitto:mosquitto /mosquitto/config /mosquitto/data /mosquitto/log
chmod 700 "$PASS"
chmod 700 /mosquitto/config/acl /mosquitto/config/mosquitto.conf
exec mosquitto -c /mosquitto/config/mosquitto.conf
