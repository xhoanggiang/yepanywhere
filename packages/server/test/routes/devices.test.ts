import { describe, expect, it, vi } from "vitest";
import type { DeviceBridgeService } from "../../src/device/DeviceBridgeService.js";
import { createDeviceRoutes } from "../../src/routes/devices.js";

describe("Device Routes", () => {
  it("returns binaryPath and apkPath from POST /bridge/download", async () => {
    const downloadRuntimeDependencies = vi.fn().mockResolvedValue({
      binaryPath: "/tmp/device-bridge-linux-amd64",
      apkPath: "/tmp/yep-device-server.apk",
    });

    const routes = createDeviceRoutes({
      deviceBridgeService: {
        downloadRuntimeDependencies,
      } as unknown as DeviceBridgeService,
    });

    const response = await routes.request("/bridge/download", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      ok: true,
      path: "/tmp/device-bridge-linux-amd64",
      binaryPath: "/tmp/device-bridge-linux-amd64",
      apkPath: "/tmp/yep-device-server.apk",
    });
    expect(downloadRuntimeDependencies).toHaveBeenCalledTimes(1);
  });
});
