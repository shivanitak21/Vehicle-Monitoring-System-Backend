# MQTT vehicle contract

The API subscribes as the backend user. Devices publish only to their own vehicle topics. QoS is 1 (at least once). Processing is idempotent on `eventId` or telemetry `eventId`. This is not exactly-once delivery, and a push provider accepting a ticket does not mean the phone displayed it.

## Topics

- `vehicles/{vehicleId}/telemetry`
- `vehicles/{vehicleId}/safety`
- `vehicles/{vehicleId}/cabin`
- `vehicles/{vehicleId}/device-status`
- `vehicles/{vehicleId}/sos`
- `vehicles/{vehicleId}/commands` (backend publish, device subscribe)

`vehicleId` in the topic is authoritative. The same id inside the payload must match. The payload `authToken` must match the device ingest key. The device record must belong to that vehicle.

## Telemetry

`source` is `vehicle_gps`, `mobile_gps`, or `demo_gps`. Demo points require `demo: true` and `source: demo_gps`. Coordinates are WGS84. `recordedAt` is ISO-8601. Live ingestion rejects timestamps more than `LOCATION_MAX_AGE_SECONDS` old or `LOCATION_MAX_FUTURE_SKEW_SECONDS` ahead.

## Safety and SOS

Driver events require `inferenceSource`. The API stores that report; it does not run a fatigue or distraction model. SOS is stored before notifications are attempted. Missing coordinates are stored as location unavailable. Optional vision review is never on the SOS path.

## Commands

Guardians send `request_status`, `display_text`, `set_brightness`, or `acknowledge_alarm` through `POST /api/v1/vehicles/{vehicleId}/commands`. The broker ACL does not let devices publish commands. A command is `published` only after the broker accepts QoS 1. Otherwise the stored status is `failed`.

## Production

Use `mqtts://`, per-vehicle usernames, and `docker/mosquitto/acl.production.example`. Anonymous access is rejected by startup checks. The development `demo-device` wildcard ACL is local only.
