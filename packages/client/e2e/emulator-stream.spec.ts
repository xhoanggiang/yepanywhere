/**
 * E2E test for Android emulator WebRTC streaming.
 *
 * Requires:
 *   - A running Android emulator (detected via `adb devices`)
 *   - The emulator-bridge binary built at packages/emulator-bridge/bridge
 *
 * Skipped automatically when either prerequisite is missing, so this is
 * safe to run in CI (where no emulator is available).
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BRIDGE_BINARY = resolve(__dirname, "../../emulator-bridge/bridge");

/** Find adb binary — checks PATH then common Android SDK locations. */
function findAdb(): string | null {
  const candidates = [
    "adb",
    join(homedir(), "Android", "Sdk", "platform-tools", "adb"),
    join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
    "/opt/android-sdk/platform-tools/adb",
  ];
  for (const candidate of candidates) {
    try {
      execSync(`${candidate} version`, { timeout: 3000, stdio: "ignore" });
      return candidate;
    } catch {
      // not found or not executable
    }
  }
  return null;
}

function findRunningEmulator(): string | null {
  const adb = findAdb();
  if (!adb) return null;
  try {
    const output = execSync(`${adb} devices`, { timeout: 5000 }).toString();
    const match = output.match(/^(emulator-\d+)\s+device$/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

test("streams emulator video over WebRTC when ?auto is set", async ({
  page,
  baseURL,
}) => {
  test.skip(
    !existsSync(BRIDGE_BINARY),
    "emulator-bridge binary not built — run: cd packages/emulator-bridge && go build -o bridge ./cmd/bridge/",
  );

  const runningEmulator = findRunningEmulator();
  test.skip(
    !runningEmulator,
    "No running Android emulator — run: emulator -avd <name> -no-window &",
  );

  await page.goto(`${baseURL}/emulator?auto`);

  // Wait for WebRTC to reach "connected" — generous timeout covers sidecar
  // cold start, ADB query, ICE gathering, and first frame.
  await expect(page.locator(".emulator-connection-state")).toHaveText(
    "connected",
    { timeout: 30_000 },
  );

  // Video element must be visible
  const video = page.locator("video.emulator-video");
  await expect(video).toBeVisible();

  // Video must have received at least one frame (readyState >= HAVE_CURRENT_DATA)
  await expect(async () => {
    const readyState = await page.evaluate(
      () =>
        (
          document.querySelector(
            "video.emulator-video",
          ) as HTMLVideoElement | null
        )?.readyState ?? 0,
    );
    expect(readyState).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 5_000 });
});
