import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("serialport", () => {
  return {
    SerialPort: {
      list: vi.fn(),
    },
  };
});

const { SerialPort } = await import("serialport");
const { discoverDevices } = await import("../src/serial/discovery.js");

describe("discoverDevices", () => {
  const listMock = SerialPort.list as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listMock.mockReset();
  });

  it("filters Grid devices and drops bogus serial numbers", async () => {
    listMock.mockResolvedValue([
      {
        path: "/dev/ttyA",
        vendorId: "03eb",
        productId: "ecac",
        serialNumber: "0000000000000000",
      },
      {
        path: "/dev/ttyB",
        vendorId: "303A",
        productId: "8123",
        serialNumber: "ABC123",
      },
      {
        path: "/dev/ttyC",
        vendorId: "1111",
        productId: "2222",
        serialNumber: "NOPE",
      },
    ]);

    const devices = await discoverDevices();

    expect(devices).toHaveLength(2);
    expect(devices[0].path).toBe("/dev/ttyA");
    expect(devices[0].serialNumber).toBeUndefined();
    expect(devices[1].path).toBe("/dev/ttyB");
    expect(devices[1].serialNumber).toBe("ABC123");
  });
});
