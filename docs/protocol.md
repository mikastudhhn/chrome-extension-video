# Protocol 3: relay contracts

The extension and the relay server speak protocol 3 over HTTPS. A room has
exactly two members. Both people retain Play/Pause/Seek rights; only the host
publishes ordered timeline state. The guest sends samples, ready, intents and
resync. Ping/pong are allowed in either direction.

`extension/protocol.js` owns the shared runtime validators and transient-message
classification; the server imports only these validators. Validate complete
batches before queue/sequence mutation, complete poll responses before
callback/cursor mutation, and peer messages before marking the connection fresh.
Timeline methods also validate direct inputs before changing their state. A valid
but stale epoch is ignored by Timeline; malformed data is rejected. Invalid
remote payloads stop the current session through the existing pause/release path.

Numbers must be finite. Epochs/revisions/cursors are nonnegative safe integers;
batch/event/intent IDs are positive safe integers. Media time and duration are
bounded at 1e9 seconds; duration is positive. Relative timeline position can be
negative (seeking before the confirmed scene). Timestamps are nonnegative finite
milliseconds up to Number.MAX_SAFE_INTEGER, including fractional milliseconds.
Media IDs are nonempty strings up to 128 characters, reset IDs up to 64. Batches
carry at most 32 messages, event queues 256, player intent lists 20. Arrays
cannot stand in for records. Seek requires a numeric time; Play and Pause
intents may omit time and intent IDs. The optional native intent epoch hint may
be null before alignment; the authoritative envelope epoch must always be
nonnegative. Unknown optional object fields are tolerated; known optional
fields, when present, are validated. The relay forwards only a copy rebuilt
from the protocol fields (`normalizeMessage`); unknown fields never reach the
peer. One normalized message may serialize to at most 6 KiB (`LIMITS.messageBytes`).

## Server limits

Defaults in `server/index.js` (`SERVER_LIMITS`) and `server/rooms.js` (`ROOM_LIMITS`):

| Limit | Value |
|---|---|
| Body | 4 KiB create/join, 16 KiB relay batch; complete within 10 s, else 408 `TIMEOUT` |
| Headers / whole request | 10 s / 15 s (Node backstop); keep-alive 125 s |
| Receiver queue | 256 events or 256 KiB, then the room closes (`overflow`) |
| All queues together | 16 MiB, then relay answers 503 `SERVER_BUSY` (retryable) |
| Per address (IPv4, IPv6 /64) | 50 requests/s (burst 200), 16 concurrent requests, 8 concurrent polls, 30 create/join per minute, 3 open rooms, 10 failed joins per minute |
| All addresses | 1 failed join per second (burst 30), 500 rooms, 512 requests in flight |
| Per member | 1200 polls and 1200 relay batches per minute |
| Rooms | idle 5 min, unjoined 30 min, lifetime 12 h |

Address limits use `X-Real-IP` only with `TRUST_PROXY=1` (set by Caddy from the
TCP peer); `X-Forwarded-For` is ignored. Without `TRUST_PROXY`, loopback clients
are exempt from address limits (local use and tests). Only successful polls and
relays refresh room activity. A newer `/events` poll for the same member answers
the parked one with `{ "events": [] }` and takes over.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /health` | `{ ok, protocol: 3, capabilities, roomRequests, incidents }` with a signed room-request lease; `incidents` maps fixed reasons (`error`, `crash`, `limits`, `capacity`, `disk`, `memory`) to their latest time in the last 24 hours, for the external monitor (`docs/hosting.md`) |
| `POST /rooms` | Create a room; returns the host membership |
| `POST /rooms/:code/join` | Join with the six-character invitation code |
| `GET /events?after=N` | Long poll for the member's ordered events (Bearer token) |
| `POST /relay` | Ordered, idempotent message batch to the other member (Bearer token) |
| `POST /leave` | Close the room for both members (Bearer token) |

Rooms are addressed only by their six-character code from the alphabet
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; invitations are case-insensitive.

## Handshake and capabilities

Create and join requests carry `{ protocol: 3, capabilities: [...], roomRequest }`.
`roomRequest` echoes the lease from `/health` with a fresh ID; only such a signed
request may be repeated after a lost response, and the server returns the same
membership instead of creating another seat. A body without `protocol: 3` and a
valid capability list is rejected with `INCOMPATIBLE_PROTOCOL` (HTTP 400) before a
room or seat is used; the popup asks to update server and extension. The client
equally rejects a server without a lease offer or a response with another
protocol number. Bump `PROTOCOL` for every incompatible wire change.

An optional `client: { version, distribution, channel }` names the extension
build for aggregate counts per build. The server keeps it only as the label
`distribution/channel/version` (a plain version and two lowercase identifiers,
anything else counts as `unknown`); it is no part of the request fingerprint and
older servers ignore it.

Responses contain `protocol`, `code`, `token`, `role`, the server
`capabilities` and the other member's `peerCapabilities`. The host learns the
guest's capabilities through the `peer-joined` event. The current capabilities
are `relay-v2` and `structured-errors-v1`. Unknown optional capabilities are
ignored. Optional `requiredCapabilities` rejects unsupported requirements before
occupying a room or consuming its second seat. Lists have at most 32 distinct
bounded identifiers. `Signaling.supports()` checks local, server and peer support.

## Errors

`runtime-errors.js` defines stable codes, categories and retry policies. HTTP,
worker and Chrome runtime failures carry an `error` string and
`failure: { code, category, retryable, message, status? }`. There are no arbitrary
details, request payloads, room credentials or stacks in this envelope. Known
codes reconstruct their canonical semantics rather than trusting remote category,
retry policy or translated text. UI recovery actions select codes. A bounded
adapter recognizes text-only errors at ingress.

Known transport errors retry only when their code allows it. Validation,
compatibility and authorization failures do not retry. Network/timeout/rate-limit
and transient server errors retain the bounded retry policy. Creation and join
retry only with the signed room request, because a lost response can already have
created a room or occupied a seat. Expected cancellation does not trigger a fatal
session callback.

Offscreen status includes optional `noticeError` alongside the `notice` string.
Dismissing a notice hides both forms.

## Runtime files

Every package contains one runtime. Packaged candidate profiles and Dev validate
ESM linking plus HTML, Worker, AudioWorklet and injected-script file references
before a build is used. Tests delete import, Worker and injected files to
demonstrate rejection.
