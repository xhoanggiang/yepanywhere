import { Hono } from "hono";
import type { DeviceBridgeService } from "../device/DeviceBridgeService.js";

interface DeviceRoutesDeps {
  deviceBridgeService: DeviceBridgeService;
}

/**
 * Creates emulator-related API routes.
 *
 * GET  /api/devices                  - List all emulators (running + stopped AVDs)
 * POST /api/devices/:id/start        - Start a stopped emulator
 * POST /api/devices/:id/stop         - Stop a running emulator
 * GET  /api/devices/:id/screenshot   - Get a JPEG screenshot thumbnail
 * POST /api/devices/bridge/download  - Download bridge runtime dependencies from GitHub
 */
export function createDeviceRoutes(deps: DeviceRoutesDeps): Hono {
  const { deviceBridgeService } = deps;
  const routes = new Hono();

  // POST /api/devices/bridge/download - Download bridge binary + Android server APK
  routes.post("/bridge/download", async (c) => {
    try {
      const { binaryPath, apkPath } =
        await deviceBridgeService.downloadRuntimeDependencies();
      return c.json({ ok: true, path: binaryPath, binaryPath, apkPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[DeviceRoutes] POST /bridge/download error:", message);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // GET /api/devices - List emulators
  routes.get("/", async (c) => {
    try {
      const devices = await deviceBridgeService.listDevices();
      return c.json(devices);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[DeviceRoutes] GET /devices error:", message);
      return c.json({ error: message }, 500);
    }
  });

  // POST /api/devices/:id/start
  routes.post("/:id/start", async (c) => {
    const id = c.req.param("id");
    try {
      await deviceBridgeService.startDevice(id);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DeviceRoutes] POST /devices/${id}/start error:`, message);
      return c.json({ error: message }, 500);
    }
  });

  // POST /api/devices/:id/stop
  routes.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    try {
      await deviceBridgeService.stopDevice(id);
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DeviceRoutes] POST /devices/${id}/stop error:`, message);
      return c.json({ error: message }, 500);
    }
  });

  // GET /api/devices/:id/screenshot
  routes.get("/:id/screenshot", async (c) => {
    const id = c.req.param("id");
    try {
      const jpeg = await deviceBridgeService.getScreenshot(id);
      return new Response(new Uint8Array(jpeg), {
        headers: { "Content-Type": "image/jpeg" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[DeviceRoutes] GET /devices/${id}/screenshot error:`,
        message,
      );
      return c.json({ error: message }, 500);
    }
  });

  return routes;
}
