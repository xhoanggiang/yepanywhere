import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceBridgeService } from "../../src/device/DeviceBridgeService.js";

type DeviceBridgeServiceTestShim = DeviceBridgeService & {
  ensureStarted: () => Promise<void>;
  ensureAndroidServerAPK: () => Promise<string>;
  sendToSidecar: (msg: Record<string, unknown>) => void;
  port: number | null;
};

describe("DeviceBridgeService", () => {
  const originalFetch = global.fetch;
  const originalUseApkForEmulator =
    process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR;

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    if (originalUseApkForEmulator === undefined) {
      process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR = undefined;
    } else {
      process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR =
        originalUseApkForEmulator;
    }
  });

  it("sends session.start with deviceId only (no legacy emulatorId)", async () => {
    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim;

    const sendToSidecar = vi.fn();
    shim.ensureStarted = vi.fn().mockResolvedValue(undefined);
    shim.sendToSidecar = sendToSidecar;

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-1",
        deviceId: "emulator-5554",
        options: { maxFps: 20, maxWidth: 480, quality: 28 },
      },
      vi.fn(),
    );

    expect(sendToSidecar).toHaveBeenCalledTimes(1);
    const payload = sendToSidecar.mock.calls[0]?.[0];
    expect(payload).toEqual({
      type: "session.start",
      sessionId: "session-1",
      deviceId: "emulator-5554",
      options: { maxFps: 20, maxWidth: 480, quality: 28 },
    });
    expect(payload).not.toHaveProperty("emulatorId");
  });

  it("does not fall back to /emulators when /devices returns 404", async () => {
    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim;

    shim.ensureStarted = vi.fn().mockResolvedValue(undefined);
    shim.port = 48765;

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(service.listDevices()).rejects.toThrow("Sidecar error: 404");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls).toEqual(["http://127.0.0.1:48765/devices"]);
    expect(requestedUrls.some((url) => url.includes("/emulators"))).toBe(false);
  });

  it("ensures Android APK before starting a physical Android stream", async () => {
    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim;

    const sendToSidecar = vi.fn();
    const ensureAndroidServerAPK = vi
      .fn()
      .mockResolvedValue("/tmp/yep-device-server.apk");
    const ensureStarted = vi.fn().mockResolvedValue(undefined);
    shim.ensureAndroidServerAPK = ensureAndroidServerAPK;
    shim.ensureStarted = ensureStarted;
    shim.sendToSidecar = sendToSidecar;

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-android",
        deviceId: "R3CN90ABCDE",
      },
      vi.fn(),
    );

    expect(ensureAndroidServerAPK).toHaveBeenCalledTimes(1);
    expect(ensureStarted).toHaveBeenCalledTimes(1);
    expect(ensureAndroidServerAPK.mock.invocationCallOrder[0]).toBeLessThan(
      ensureStarted.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(sendToSidecar).toHaveBeenCalledWith({
      type: "session.start",
      sessionId: "session-android",
      deviceId: "R3CN90ABCDE",
      options: undefined,
    });
  });

  it("does not ensure Android APK for default emulator streams", async () => {
    process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR = undefined;

    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim;

    shim.ensureAndroidServerAPK = vi
      .fn()
      .mockResolvedValue("/tmp/yep-device-server.apk");
    shim.ensureStarted = vi.fn().mockResolvedValue(undefined);
    shim.sendToSidecar = vi.fn();

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-emu",
        deviceId: "emulator-5554",
      },
      vi.fn(),
    );

    expect(shim.ensureAndroidServerAPK).not.toHaveBeenCalled();
  });

  it("ensures Android APK for emulator streams when APK override mode is enabled", async () => {
    process.env.DEVICE_BRIDGE_USE_APK_FOR_EMULATOR = "true";

    const service = new DeviceBridgeService({
      adbPath: "adb",
      dataDir: "/tmp/yep-anywhere-test",
    });
    const shim = service as unknown as DeviceBridgeServiceTestShim;

    shim.ensureAndroidServerAPK = vi
      .fn()
      .mockResolvedValue("/tmp/yep-device-server.apk");
    shim.ensureStarted = vi.fn().mockResolvedValue(undefined);
    shim.sendToSidecar = vi.fn();

    await service.startStream(
      {
        type: "device_stream_start",
        sessionId: "session-emu-apk",
        deviceId: "emulator-5554",
      },
      vi.fn(),
    );

    expect(shim.ensureAndroidServerAPK).toHaveBeenCalledTimes(1);
  });
});
