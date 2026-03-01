# Phase 0 Results: Emulator gRPC API Validation (2026-03-01)

## Environment

- **Emulator:** v36.3.10 (build 14472402)
- **AVD:** jstorrent-dev (Pixel 6, API 34, arm64)
- **Screen:** 1080x2400 @ 420 dpi
- **GPU:** `-gpu off` (software rendering via SwiftShader)
- **Host:** macOS Darwin 25.2.0, Apple Silicon

## Strategy Decision: Strategy B (confirmed)

The `Rtc` gRPC service is **not available** in emulator v36.3.10. The only service exposed is `EmulatorController`. The proto files (`/Android/Sdk/emulator/lib/`) contain no WebRTC-related definitions. Strategy A is ruled out — the sidecar must handle encoding and WebRTC itself.

## gRPC Authentication

The emulator uses **Bearer token** authentication for gRPC (not JWT, despite the flag names). The flow:

1. Find the emulator PID (from `adb devices` — emulator-5554 → console port 5554 → PID from discovery)
2. Read the discovery file at `~/Library/Caches/TemporaryItems/avd/running/pid_{PID}.ini` (macOS)
3. Extract the `grpc.token` value
4. Send as `Authorization: Bearer {token}` header on every gRPC call

The discovery file also contains: `grpc.port`, `avd.name`, `avd.id`, `port.serial`, `port.adb`.

The emulator console (`telnet localhost 5554`) supports `avd discoverypath` to get the discovery file path.

## API Test Results

| API | Format | Resolution | Latency | Data Size | Notes |
|-----|--------|-----------|---------|-----------|-------|
| `getStatus` | — | — | <1ms | — | Works, returns hw config with screen dimensions |
| `getScreenshot` | PNG | 1080x2400 | ~415ms | 1.8 MB | Usable for thumbnails |
| `getScreenshot` | RGB888 | 1080x2400 | ~70ms | 7.42 MB | Fast, good for streaming |
| `streamScreenshot` | RGB888 | 1080x2400 | — | 7.42 MB/frame | See streaming results below |
| `sendTouch` | — | — | <1ms | — | Works, pressure-based (0=release) |
| `sendKey` | — | — | <1ms | — | Works, string key names ("Home") |

## Width Scaling

**The `width` parameter in `ImageFormat` is ignored for RGB888.** Requesting width=720 or width=480 still returns full 1080x2400 frames. This means the sidecar must downscale frames before encoding.

PNG format may respect width scaling (not tested thoroughly), but PNG encoding is too slow for streaming (~415ms/frame).

## Streaming Results

With continuous touch activity (simulated swipe gestures):

| Metric | Value |
|--------|-------|
| Frames in 5s | 15 |
| FPS | 3.1 |
| Data rate | 24.7 MB/s |
| Frame interval (avg) | 321 ms |
| Frame interval (min) | 95 ms |
| Frame interval (max) | 483 ms |
| Frame size | 7.42 MB (constant, full res) |

**Key observations:**
- The stream only delivers frames when the screen content changes (per spec: "A new frame will be delivered whenever the device produces a new frame")
- The low FPS (3.1) is due to `-gpu off` (software rendering). With hardware GPU, expect 30-60 FPS
- At full resolution RGB888, data throughput is ~25 MB/s over localhost gRPC — more than sufficient
- The gRPC max message size must be increased beyond the default 4MB (frames are 7.42 MB)
- Static screens produce no frames — the sidecar should cache the last frame for new WebRTC connections

## Implications for Sidecar Design

1. **Must downscale in sidecar** — emulator doesn't scale RGB888. Use pure Go pixel scaling (or let x264 handle it with resolution parameter)
2. **Must handle variable frame rate** — frames are event-driven, not periodic. The sidecar should maintain a target FPS by either:
   - Repeating the last frame when idle (wastes bandwidth)
   - Only encoding new frames and letting WebRTC handle the gap (preferred — browsers handle variable rate well)
3. **gRPC auth is required** — the sidecar must read the discovery file and pass the token. This also means the sidecar needs to watch for emulator restarts (new PID → new token)
4. **GPU acceleration matters** — document that users should run emulators with GPU enabled for better streaming performance. The current test was worst-case (software rendering)

## Validation Script

Located at `packages/emulator-bridge/cmd/validate/main.go`. Run with:

```bash
cd packages/emulator-bridge && go run ./cmd/validate/
```
