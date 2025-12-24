import { deviceManager } from "../device/manager.js";
import * as log from "../utils/logger.js";
import { GridError } from "../utils/errors.js";

export interface ClearOptions {
  device?: string;
  dryRun?: boolean;
}

/**
 * Clear device configuration (factory reset)
 */
export async function clearCommand(options: ClearOptions): Promise<void> {
  if (options.dryRun) {
    log.info("[Dry run] Would erase device NVM.");
    return;
  }

  let device;
  try {
    device = await deviceManager.connect(options.device);
    const modules = device.getModules();
    if (modules.length === 0) {
      throw new GridError(
        "No modules found on device. Is the Grid connected properly?",
      );
    }

    await device.eraseNvm();

    log.info("Waiting for device to restart...");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await device.waitForModules(5000);
  } finally {
    if (device) {
      await deviceManager.disconnect(device);
    }
  }
}
