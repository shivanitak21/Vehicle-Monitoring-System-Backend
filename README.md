# Vehicle Safety Backend

API for guardian trip monitoring: accounts, family consent, vehicles, live GPS, MQTT device ingestion, SOS alerts, and private incident media metadata.

The React Native app in the sibling `Mobile` folder is not modified by this service. Canonical routes live under `/api/v1`. A `/v1` compatibility surface matches the mobile client's current paths.

## Prerequisites

- Node.js 20 or newer (the Docker image uses Node.js 22)
- npm
- Docker, if you want local MongoDB and Mosquitto

MongoDB Atlas works through `MONGODB_URI` without Docker.

## Setup

```bash
cd Backend
cp .env.example .env
npm install
docker compose up -d mongo mosquitto
npm run seed
npm run dev
```

- API: `http://localhost:4000`
- OpenAPI UI: `http://localhost:4000/docs`
- Liveness: `GET /health/live`
- Readiness: `GET /health/ready`

Seed creates a demo guardian, passenger, vehicle `DEMO-001`, device `demo-device`, and an active demo trip. Passwords come from `.env` and are development samples. Replace them before any shared environment. The seed refuses `NODE_ENV=production`.

Run the simulator in another terminal:

```bash
npm run demo:vehicle
npm run demo:vehicle -- --speed 35 --interval 2000 --sos
```

Ctrl+C stops it. Every simulated payload has `demo: true`. Production startup rejects `DEMO_ENABLED=true`, default secrets, anonymous MQTT, and non-TLS MQTT when MQTT is enabled.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Environment

See `.env.example`. Values that must be set for a real deployment:

- `MONGODB_URI`
- `JWT_ACCESS_SECRET` (32+ characters, not the sample)
- `CORS_ORIGINS`
- `MQTT_URL` (`mqtts://` in production), `MQTT_USERNAME`, `MQTT_PASSWORD`
- `EXPO_PUSH_ACCESS_TOKEN` for real push delivery
- `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and optionally `S3_ENDPOINT`
- `VISION_PROVIDER_URL` only if a cabin-review provider exists

Empty push, storage, vision, and speech settings stay unconfigured. The API does not invent delivery, media, or inference.

## Mobile connection

In the mobile `.env`:

```bash
EXPO_PUBLIC_API_URL=http://YOUR_HOST:4000/v1
EXPO_PUBLIC_SOCKET_URL=http://YOUR_HOST:4000
```

Login returns `token` (the access token) and `refreshToken`. The current app stores only `token`. Refresh is available at `POST /v1/auth/refresh` when the client is ready to store it.

Socket details are in `docs/socket.md`. The app's trip screen assumes `driver.rating` and `current` are always present and formats `etaMinutes` as a number. This API returns `null` for rating, ETA, and coordinates when they are unknown.

## Authorization

Self-registration allows `guardian` and `passenger` only. Guardians receive a family group. A guardian can see a trip only when the passenger has granted consent and the trip lists that guardian. Revocation removes access even if the trip still contains the old id. Other families receive 404. Administrators are created only by the seed script.

Refresh tokens are random, stored as SHA-256 hashes, and rotated. Reuse of a revoked token revokes that token family.

## Data and alerts

Location history and safety events are separate collections. GPS uses GeoJSON with a 2dsphere index. A vehicle is not reported as moving when the last fix is older than `LOCATION_STALE_AFTER_SECONDS`. Route responses are recorded points only. `eta` is null and `routingAvailability` is `not_configured`.

Risk state is `normal`, `warning`, `critical`, `unknown`, `stale`, or `offline`. The formula version is `2026.1`. No percentage is returned. Absence of events is `unknown` or `normal` only when fresh location exists, and the explanation says that is not a determination the passenger is safe.

SOS is stored before notification fan-out. Only guardians with consent and `receiveAlerts` who are on the trip are notified. Missing GPS is described as unavailable. Push status `provider_accepted` means the Expo API accepted the ticket, not that it was delivered or read. Without `EXPO_PUSH_ACCESS_TOKEN`, development logs a simulated notification and other environments record `unavailable`.

## Media and inference

Upload flow:

1. `POST /api/v1/incidents/:incidentId/media/upload-url`
2. Client uploads bytes directly to object storage
3. `POST /api/v1/incidents/:incidentId/media/complete`
4. `GET /api/v1/media/:mediaId/access-url` returns a short-lived URL

Camera consent and trip media sharing are required. Without S3 settings the upload-url call returns `503 STORAGE_UNAVAILABLE` and writes no media row.

Speech events accept structured provider output. Raw audio is discarded. A transcript is stored only when `includeTranscript` is set and speech consent is on. Cabin still review calls `VISION_PROVIDER_URL` with a timeout and records the result as model-generated. It does not identify a person or decide that someone is safe. No driver, seat, speech, or vision model runs inside this process.

## Hardware still required

- Vehicle computer and authenticated MQTT credentials
- Driver-facing camera and its monitoring model
- Cabin camera and seat-occupancy model
- LVGL display consuming `vehicles/{vehicleId}/commands`
- TLS certificates for Mosquitto
- Expo push credentials
- Private object storage
- Optional speech provider and vision-language HTTP provider

Broker ACL, topic schemas, and command types are the integration boundary. Device heartbeats update connectivity. They do not mean a camera model ran unless the device says so.

## Operations

Retention deletes location points older than `LOCATION_RETENTION_DAYS` and expires media. Critical notifications retry with backoff from MongoDB. There is one API process; rate limits are in memory. Readiness fails when MongoDB is down or MQTT is enabled but disconnected. Shutdown closes the HTTP server, MQTT client, jobs, and database connection.
