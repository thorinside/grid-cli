import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { SerialConnection } from "../src/serial/connection.js";

vi.mock("../src/protocol/codec.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/protocol/codec.js")>();
  return {
    ...actual,
    decodeMessage: vi.fn(),
  };
});

const { GridDevice } = await import("../src/device/device.js");
const { decodeMessage, ClassName } = await import("../src/protocol/codec.js");

class FakeConnection extends EventEmitter {
  device = {
    path: "/dev/ttyFAKE",
    vid: 0x03eb,
    pid: 0xecac,
    name: "Grid D51",
    serialNumber: "SN123",
  };
  isOpen = true;
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  async write(): Promise<void> {}
}

describe("GridDevice heartbeat discovery", () => {
  const decodeMock = decodeMessage as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    decodeMock.mockReset();
  });

  it("discovers modules when heartbeat fields are numeric strings", async () => {
    decodeMock.mockReturnValue([
      {
        brc_parameters: { SX: "0", SY: "0" },
        class_name: ClassName.HEARTBEAT,
        class_instr: "REPORT",
        class_parameters: {
          HWCFG: "1",
          VMAJOR: "1",
          VMINOR: "2",
          VPATCH: "3",
        },
      },
      {
        brc_parameters: { SX: "1", SY: "0" },
        class_name: ClassName.HEARTBEAT,
        class_instr: "REPORT",
        class_parameters: {
          HWCFG: "0",
          VMAJOR: "2",
          VMINOR: "0",
          VPATCH: "5",
        },
      },
    ]);

    const connection = new FakeConnection();
    const device = new GridDevice(connection as unknown as SerialConnection);

    connection.emit("message", Buffer.from([0x01, 0x02]));

    const modules = await device.waitForModules(50);

    expect(modules).toHaveLength(2);
    expect(modules[0].type).toBe("BU16");
    expect(modules[0].firmware).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(modules[1].type).toBe("PO16");
    expect(modules[1].firmware).toEqual({ major: 2, minor: 0, patch: 5 });
  });
});
