# Example requests

Replace the token and ids. The API base is `http://localhost:4000/api/v1`.

```bash
curl -s http://localhost:4000/health/ready

curl -s -X POST http://localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"guardian@example.com","password":"DevOnly-ChangeMe-12345"}'

curl -s http://localhost:4000/api/v1/dashboard/summary \
  -H "authorization: Bearer $TOKEN"

curl -s -X POST http://localhost:4000/api/v1/safety/sos \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"tripId":"TRIP_ID","eventId":"sos-manual-1"}'
```

Device telemetry:

```bash
curl -s -X POST http://localhost:4000/api/v1/devices/telemetry \
  -H 'content-type: application/json' \
  -H 'x-device-identity: demo-device' \
  -H 'x-device-key: dev-device-ingest-key-change-me' \
  -d '{"vehicleId":"VEHICLE_ID","tripId":"TRIP_ID","latitude":37.77,"longitude":-122.42,"speedKph":30,"heading":90,"accuracyMeters":5,"recordedAt":"2026-10-20T12:00:00.000Z","sequence":1,"eventId":"gps-1","source":"demo_gps","demo":true}'
```

A missing object-storage configuration returns `503` with code `STORAGE_UNAVAILABLE`. No media row is created.
