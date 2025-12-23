import { discoverDevices, findDevice } from "../serial/discovery.js";
import { SerialConnection } from "../serial/connection.js";
import { GridDevice } from "./device.js";
import { ConnectionError } from "../utils/errors.js";
import * as log from "../utils/logger.js";
import type { DeviceInfo } from "./types.js";

/**
 * Manages Grid device discovery and connections
 */
export class DeviceManager {
  private devices: Map<string, GridDevice> = new Map();

  /**
   * Discover all connected Grid devices
   */
  async discover(): Promise<DeviceInfo[]> {
    return discoverDevices();
  }

  /**
   * Connect to a specific device or first available
   */
  async connect(path?: string): Promise<GridDevice> {
    const deviceInfo = await findDevice(path);

    if (!deviceInfo) {
      throw new ConnectionError(
        path
          ? `Device not found at ${path}`
          : "No Grid devices found. Make sure a device is connected."
      );
    }

    // Check if already connected
    if (this.devices.has(deviceInfo.path)) {
      return this.devices.get(deviceInfo.path)!;
    }

    log.info(`Connecting to ${deviceInfo.name} at ${deviceInfo.path}...`);

    const connection = new SerialConnection(deviceInfo);
    const device = new GridDevice(connection);

    await device.open();

    // Wait for module discovery
    log.info("Waiting for modules...");
    const modules = await device.waitForModules();

    if (modules.length === 0) {
      log.warn("No modules discovered. Device may not be responding.");
    } else {
      log.success(`Connected! Found ${modules.length} module(s):`);
      for (const module of modules) {
        log.info(
          `  - ${module.type} at (${module.dx}, ${module.dy}) - firmware ${module.firmware.major}.${module.firmware.minor}.${module.firmware.patch}`
        );
      }
    }

    this.devices.set(deviceInfo.path, device);

    return device;
  }

  /**
   * Disconnect from a device
   */
  async disconnect(device: GridDevice): Promise<void> {
    await device.close();
    this.devices.delete(device.deviceInfo.path);
    log.info("Disconnected");
  }

  /**
   * Disconnect from all devices
   */
  async disconnectAll(): Promise<void> {
    const errors: Error[] = [];
    for (const device of this.devices.values()) {
      try {
        await device.close();
      } catch (err) {
        log.warn(`Failed to close device: ${err instanceof Error ? err.message : String(err)}`);
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.devices.clear();
    if (errors.length > 0) {
      log.warn(`${errors.length} device(s) failed to close cleanly`);
    }
  }
}

// Singleton instance
export const deviceManager = new DeviceManager();
