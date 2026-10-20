# Socket.IO

Connect to the API origin, not the `/api/v1` path.

```javascript
import { io } from 'socket.io-client';

const socket = io('http://localhost:4000', {
  auth: { token: accessToken },
  transports: ['websocket'],
});
```

The server verifies the access token and joins `user:{userId}`. It does not place the socket in a global room.

## Subscribe

```javascript
socket.emit('room:join', { tripId }, (response) => {
  // { ok: true } or { ok: false, code: 'FORBIDDEN' }
});
```

Trip access uses the same family consent and trip-sharing rules as HTTP. A guessed trip id is rejected.

## Server events

- `location:update` — canonical GPS payload (`vehicleId`, `tripId`, `latitude`, `longitude`, `speedKph`, `heading`, `accuracyMeters`, `recordedAt`, `source`, `demo`)
- `trip:location` — smaller payload for the current mobile client
- `trip:status` — includes `canonicalStatus` plus `etaAvailability: "not_configured"`
- `safety:event`
- `safety:sos`
- `vehicle:status`
- `cabin:status` and `cabin:state`
- `incident:created`
- `notification:created`

Events are saved before they are emitted. Reconnect with the same access token. Ignore a location whose `recordedAt` is older than the fix already shown. Passengers may submit `location:update` for their own active trip; stale client messages are rejected.

The current mobile app listens for `trip:location`, `trip:status`, `safety:event`, and `cabin:state`. Those aliases are emitted in addition to the canonical names. `etaMinutes` and `progress` are null because no routing provider is configured. `driver.rating` is null. Some safety kinds (`face_not_detected`, `camera_offline`, `gps_stale`) are not in the current mobile label map, so read `eventType` before rendering them.
