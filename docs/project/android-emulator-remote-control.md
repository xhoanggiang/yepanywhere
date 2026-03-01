# Android Emulator Remote Control

## Vision

Yep Anywhere helps you supervise Claude agents from your phone. But when those agents are building Android apps, you still have to walk over to your desktop to see the result in the emulator. This feature closes that gap: stream a running Android emulator to your phone and control it with touch, right from a new tab in the yep anywhere client.

Not a general-purpose remote desktop. A purpose-built, dev-focused tool for checking builds, tapping through UI flows, and debugging layouts — from wherever you are.

## Discovery & Lifecycle

Auto-detect, no manual configuration:

1. **Detect ADB** — on server startup, check if `adb` is on PATH. If not, the feature is hidden entirely.
2. **List AVDs** — run `emulator -list-avds` to discover available emulator profiles (Pixel 7, Tablet, etc.).
3. **Probe status** — run `adb devices` to see which emulators are currently running.
4. **Present in UI** — settings/emulator section shows each AVD with its status (stopped / running). User can launch a stopped AVD from the UI.
5. **Connect** — tapping a running emulator opens it in a dedicated tab (same UX as opening a new Claude session tab).

## Architecture Overview

The primary use case is **relay connections** (phone → relay → server), not LAN. Video must NOT go through the relay — the relay is designed for lightweight control messages, not video bandwidth. WebRTC provides a direct peer-to-peer connection between the dev machine and the phone, bypassing the relay entirely for media.

### System Diagram

```
Phone                          Relay                Yep Server              Sidecar (Go)         Emulator
  │                              │                      │                      │                    │
  │◄══ WSS (relay) ════════════►│◄══ WSS ═════════════►│                      │                    │
  │  encrypted control msgs      │  encrypted control   │                      │                    │
  │  + signaling passthrough     │  msgs                │◄── WS localhost ───►│                    │
  │                              │                      │   signaling only     │                    │
  │                              │                      │   (JSON, light)      │◄── gRPC ─────────►│
  │                              │                      │                      │   localhost:8554   │
  │                              │                      │                      │   frames + input   │
  │◄═════════════════════ WebRTC P2P (UDP) ════════════════════════════════════►│                    │
  │  video: h264 track (hardware decoded on phone)                             │                    │
  │  data channel: touch events (phone → sidecar)                              │                    │
```

### What flows on each connection

**Phone ↔ Relay ↔ Yep Server** (existing WebSocket, already built):
- Normal Claude session messages (unchanged)
- Emulator signaling: SDP offer/answer, ICE candidates (small JSON, handful of messages at setup, then silent)
- Emulator control: "start stream", "stop stream" (rare)

**Yep Server ↔ Sidecar** (localhost WebSocket):
- Forward signaling from client (SDP, ICE)
- Session lifecycle (start/stop)
- Emulator state changes

**Sidecar ↔ Emulator** (localhost gRPC):
- `streamScreenshot` → continuous raw frames (if doing our own encoding)
- `Rtc` service → built-in WebRTC signaling (if leveraging emulator's encoder)
- `sendTouch` / `sendKey` ← from DataChannel input
- `getStatus` ← screen dimensions

**Sidecar ↔ Phone** (WebRTC P2P, punches through NAT):
- Video track: h264 frames, hardware decoded by the phone browser
- DataChannel: touch/key events

**NAT traversal:** Public STUN servers (e.g., `stun:stun.l.google.com:19302`) for ICE candidate discovery. No TURN server — this is a best-effort feature. If NAT is too restrictive (symmetric NAT on both sides), it fails gracefully with a clear message. Users behind strict NAT can enable UPnP or set up port forwarding.

## The Sidecar: Go + Pion

### Why a sidecar binary (not a Node package)

Yep Anywhere has zero native dependencies. Adding WebRTC to the Node process would require either:
- `node-webrtc` / `wrtc` — native compilation (node-gyp), fragile prebuilt binaries
- `werift` — pure TS but immature, less battle-tested

A separate Go binary keeps the Node dependency tree clean and uses the most proven WebRTC stack available.

### Why Go + Pion

- **Pion** is the most mature non-browser WebRTC implementation. It's what LiveKit is built on. Production-grade ICE/STUN/DTLS handling.
- Go cross-compiles to a **single static binary** with zero runtime dependencies. `GOOS=darwin GOARCH=arm64 go build` — done.
- Users never install Go. They get a pre-built binary.
- Rich debugging ecosystem for NAT traversal issues (where things will inevitably go wrong).

### Distribution: auto-download on first use

Like how Playwright downloads browser binaries. The user never manually installs anything:

1. User enables "Emulator Streaming" in settings (or connects to an emulator for the first time)
2. Server checks `~/.yep-anywhere/bin/emulator-bridge-{os}-{arch}`
3. If missing, downloads the matching binary from a GitHub release
4. Binary is cached, subsequent launches are instant

For Tauri desktop users, the binary is bundled in the app — zero network fetch needed.

CI builds binaries for all platforms in one GitHub Actions workflow:
- `darwin-arm64` (Apple Silicon Mac)
- `darwin-amd64` (Intel Mac)
- `linux-amd64`
- `linux-arm64` (Raspberry Pi, etc.)

## Video Encoding: Two Strategies

### Strategy A: Emulator's built-in WebRTC (explore first)

Newer Android emulators expose an `Rtc` gRPC service:

```protobuf
service Rtc {
  rpc requestRtcStream(RtcId) returns (stream RtcPacket);
  rpc sendJsepMessage(JsepMsg) returns (JsepMsg);
  rpc receiveJsepMessages(RtcId) returns (stream JsepMsg);
}
```

If this works, the emulator handles h264 encoding and WebRTC internally. The sidecar just proxies signaling between the phone and the emulator's built-in WebRTC peer. ~200 lines of Go, no encoding dependency at all.

**Unknown:** whether the emulator's ICE configuration is flexible enough to accept custom STUN servers and punch through real-world NATs. Android Studio only uses this for same-machine connections. Needs empirical testing.

### Strategy B: gRPC frames → x264 → Pion (fallback)

If Strategy A doesn't work, the sidecar encodes video itself:

```
Emulator gRPC                Sidecar                           Phone
  │                             │                                │
  │── streamScreenshot ────────▶│                                │
  │   RGB888 raw pixels         │── RGB→YUV420 (pure Go)        │
  │   (~2.7MB/frame @720p)     │── x264 encode (CGo, static)   │
  │                             │── Pion WriteSample ───────────▶│
  │                             │   (RTP packetization)          │
  │                             │                                │
  │                             │════ WebRTC UDP ═══════════════▶│
  │                             │                  hardware h264 │
  │                             │                  decode (free)  │
```

- **x264** is linked via CGo and statically compiled into the binary. No runtime dependency.
- RGB→YUV420 color conversion is pure Go (just arithmetic).
- Pion's `WriteSample` handles RTP packetization — you hand it h264 NAL units (Annex B format), it does the rest.
- The binary grows ~3-5MB from x264. Still small.
- CGo cross-compilation handled by CI (build on each platform, or use `zig cc`).

## IPC Protocol: Yep Server ↔ Sidecar

The sidecar is a localhost HTTP + WebSocket server. Similar pattern to Chrome native messaging.

### Startup

```
1. Yep server spawns: ./emulator-bridge --adb-path /path/to/adb
2. Sidecar picks a random available port
3. Sidecar prints to stdout: {"port": 52387, "version": "0.1.0"}
4. Yep server reads that line, connects
5. If sidecar crashes, server marks feature unavailable
```

### REST Endpoints (control + diagnostics)

```
GET  /health
  → { "ok": true, "version": "0.1.0", "uptime": 3600 }

GET  /emulators
  → [
      { "id": "emulator-5554", "avd": "Pixel_7", "state": "running" },
      { "id": "emulator-5556", "avd": "Tablet",  "state": "stopped" }
    ]

POST /emulators/:id/start
  → { "ok": true }

POST /emulators/:id/stop
  → { "ok": true }

GET  /emulators/:id/screenshot
  → JPEG bytes (single frame, for dashboard thumbnails)

POST /shutdown
  → (sidecar exits cleanly)
```

### WebSocket Protocol (signaling)

Single WebSocket at `ws://localhost:{port}/ws`. All messages are JSON with a `type` field. This channel goes mostly idle once WebRTC is established.

**Server → Sidecar:**

```jsonc
// Client wants to start streaming
{
  "type": "session.start",
  "sessionId": "abc-123",
  "emulatorId": "emulator-5554",
  "options": { "maxFps": 30, "maxWidth": 720 }
}

// Forward SDP answer from client
{
  "type": "webrtc.answer",
  "sessionId": "abc-123",
  "sdp": "v=0\r\no=- ..."
}

// Forward ICE candidate from client
{
  "type": "webrtc.ice",
  "sessionId": "abc-123",
  "candidate": { ... }
}

// Client disconnected
{
  "type": "session.stop",
  "sessionId": "abc-123"
}
```

**Sidecar → Server:**

```jsonc
// Peer connection created, here's the offer
{
  "type": "webrtc.offer",
  "sessionId": "abc-123",
  "sdp": "v=0\r\no=- ..."
}

// ICE candidate from sidecar
{
  "type": "webrtc.ice",
  "sessionId": "abc-123",
  "candidate": { ... }
}

// Connection state updates
{
  "type": "session.state",
  "sessionId": "abc-123",
  "state": "connecting" | "connected" | "disconnected" | "failed",
  "error": "ICE negotiation timed out"  // optional
}

// Emulator appeared/disappeared
{
  "type": "emulator.state",
  "emulatorId": "emulator-5554",
  "state": "running" | "stopped"
}
```

### Full Signaling Flow

```
Phone                  Yep Server           Sidecar              Emulator
  │                        │                    │                    │
  │── "start stream" ─────▶│                    │                    │
  │                        │── session.start ──▶│                    │
  │                        │                    │── gRPC connect ───▶│
  │                        │                    │                    │
  │                        │◀─ webrtc.offer ───│                    │
  │◀── relay SDP offer ───│                    │                    │
  │                        │                    │                    │
  │── relay SDP answer ───▶│                    │                    │
  │                        │── webrtc.answer ──▶│                    │
  │                        │                    │                    │
  │◀──── ICE candidates exchanged via relay ───▶│                    │
  │                        │                    │                    │
  │◄══════════════ WebRTC P2P established ═════▶│                    │
  │  video: h264                                │── gRPC frames ───▶│
  │  data channel: touch ──────────────────────▶│── gRPC sendTouch ▶│
  │                        │                    │                    │
  │  (relay no longer involved in media)        │                    │
```

## Input Handling

Touch events on the phone browser map naturally to emulator input:

- `touchstart` / `touchmove` / `touchend` → scale coordinates to emulator resolution → `sendTouch` via gRPC
- The browser provides pressure and multi-touch (multiple `Touch` objects in `TouchEvent.touches`), which the gRPC API accepts
- Pinch-to-zoom, swipe gestures, long press — all work natively through coordinate + pressure relay
- Hardware keys (back, home, recents) → UI buttons in the tab → `sendKey` via gRPC

Coordinate mapping: `emulatorX = touchX * (emulatorWidth / canvasWidth)`

Touch events flow over the WebRTC DataChannel (not through the relay), so input latency is the same as video latency.

## Implementation Plan

### Phase 0 — Validate the emulator gRPC APIs ✅

**Status:** Complete. See [emulator-phase0-results.md](emulator-phase0-results.md) for full results.

**Outcome:** Strategy B confirmed — the emulator's `Rtc` service doesn't exist in v36.3.10. The sidecar must handle encoding and WebRTC. All gRPC APIs (`getStatus`, `getScreenshot`, `streamScreenshot`, `sendTouch`, `sendKey`) work. gRPC auth uses a Bearer token from a per-PID discovery file. Width scaling is ignored for RGB888 — sidecar must downscale.

### Phase 1 — Minimal sidecar with WebRTC

**Goal:** Go binary that streams emulator video to a browser via WebRTC.

Steps:
1. Scaffold the Go project (Pion, gRPC client, HTTP/WS server)
2. Implement the encoding pipeline (Strategy A or B based on Phase 0 results)
3. Hard-code a single emulator connection, no IPC yet
4. Test with a local HTML page that does `new RTCPeerConnection()` — open it in a browser, see the emulator screen, tap and see touch events arrive
5. Validate h264 hardware decode works on iOS Safari and Android Chrome

**Gate:** Can we see and interact with the emulator from a browser tab with acceptable latency (<200ms)?

### Phase 2 — IPC integration with Yep server

**Goal:** Yep server spawns and communicates with the sidecar.

Steps:
1. Implement the REST endpoints and WebSocket protocol in the sidecar
2. Add sidecar lifecycle management to Yep server (spawn, port handshake, crash recovery)
3. Proxy signaling messages: client WS ↔ server ↔ sidecar WS
4. Add ADB discovery to the Yep server (shell out to `adb devices`, `emulator -list-avds`)
5. Server reports `emulator` capability to clients

**Gate:** Server can start the sidecar, list emulators, and proxy a WebRTC connection through to the client.

### Phase 3 — Client UI

**Goal:** Emulator tab in the Yep Anywhere client.

Steps:
1. Emulator settings section: list AVDs, status, start/stop buttons
2. Emulator tab: `<video>` element for WebRTC stream, touch event capture, coordinate mapping
3. On-screen Android nav buttons (back, home, recents)
4. Connection state UI (connecting spinner, error messages, reconnect)
5. Test the full flow: phone → relay → server → sidecar → emulator, with WebRTC P2P for media

**Gate:** Full end-to-end flow works from a phone through the relay.

### Phase 4 — Distribution & polish

**Goal:** Users can install and use the feature without manual steps.

Steps:
1. CI pipeline: build Go binaries for all platforms, attach to GitHub releases
2. Auto-download logic in the Yep server
3. Bundle binary in Tauri desktop app
4. Adaptive quality/framerate based on connection quality
5. Orientation handling (portrait/landscape switching)
6. Screenshot capture button (single frame save)

## Scope & Non-Goals

**In scope:**
- Auto-discovery of emulators via ADB
- Start/stop emulators from UI
- Stream emulator screen to phone via WebRTC
- Touch input from phone to emulator
- Works over relay connections (primary) and direct LAN

**Non-goals:**
- General-purpose remote desktop
- Streaming arbitrary desktop windows
- Audio streaming
- File transfer to/from emulator (use ADB directly)

**Future extensions (not v1):**
- **Physical Android devices** via scrcpy — the device does h264 encoding on-hardware, sidecar just forwards the stream to Pion. Potentially easier than emulators since no encoding in the sidecar. Would need the `scrcpy-server.jar` (~50KB) and `adb`.
- Adaptive bitrate / resolution negotiation
- Multi-emulator simultaneous streaming
