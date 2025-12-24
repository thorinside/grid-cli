import { SerialPort } from "serialport";
import { GRID_DEVICES, type DeviceInfo } from "../device/types.js";
import * as log from "../utils/logger.js";

function normalizeSerialNumber(serialNumber?: string): string | undefined {
  if (!serialNumber) return undefined;
  const trimmed = serialNumber.trim();
  if (!trimmed) return undefined;

  const lowered = trimmed.toLowerCase();
  if (lowered === "n/a" || lowered === "na" || lowered === "unknown") {
    return undefined;
  }

  const cleaned =
    trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? trimmed.slice(2)
      : trimmed;
  if (/^0+$/.test(cleaned)) {
    return undefined;
  }

  return trimmed;
}

/**
 * Discover connected Grid devices by scanning serial ports
 */
export async function discoverDevices(): Promise<DeviceInfo[]> {
  const ports = await SerialPort.list();
  const devices: DeviceInfo[] = [];

  log.debug(`Found ${ports.length} serial ports`);

  for (const port of ports) {
    const vid = parseInt(port.vendorId || "0", 16);
    const pid = parseInt(port.productId || "0", 16);

    const gridDevice = GRID_DEVICES.find((d) => d.vid === vid && d.pid === pid);

    if (gridDevice) {
      log.debug(`Found Grid device: ${gridDevice.name} at ${port.path}`);
      devices.push({
        path: port.path,
        vid,
        pid,
        name: gridDevice.name,
        serialNumber: normalizeSerialNumber(port.serialNumber),
      });
    }
  }

  return devices;
}

/**
 * Find a specific device by path or return first available
 */
export async function findDevice(path?: string): Promise<DeviceInfo | null> {
  const devices = await discoverDevices();

  if (devices.length === 0) {
    return null;
  }

  if (path) {
    return devices.find((d) => d.path === path) || null;
  }

  return devices[0];
}
