import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { writeConfig } from "../src/config/writer.js";
import { readConfig } from "../src/config/reader.js";
import { getEventDescriptors } from "../src/device/events.js";
import type { ModuleConfig } from "../src/device/types.js";

function buildConfigWithDefaultPage(): ModuleConfig {
  const elementType = "button";
  const descriptors = getEventDescriptors(elementType);
  const primaryDescriptor = descriptors[0];
  if (!primaryDescriptor) {
    throw new Error("No event descriptor found for test");
  }

  return {
    module: {
      dx: 0,
      dy: 0,
      type: "TEST",
      typeId: 999,
      firmware: { major: 1, minor: 0, patch: 0 },
      elementCount: 1,
    },
    pages: [
      {
        pageNumber: 0,
        events: [
          {
            elementIndex: 0,
            eventType: primaryDescriptor.value,
            actions: [{ short: "log", code: "print('hello')" }],
          },
        ],
      },
      {
        pageNumber: 1,
        events: [
          {
            elementIndex: 0,
            eventType: primaryDescriptor.value,
            actions: [],
          },
        ],
      },
    ],
  };
}

describe("config pages", () => {
  it("skips pages that only contain default actions", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grid-config-"));
    try {
      const config = buildConfigWithDefaultPage();
      await writeConfig([config], tmpDir);

      const modules = await fs.readdir(tmpDir);
      expect(modules.length).toBe(1);

      const moduleDir = path.join(tmpDir, modules[0]);
      const moduleEntries = await fs.readdir(moduleDir);

      expect(moduleEntries).toContain("module.json");
      expect(moduleEntries).toContain("page-0.lua");
      expect(moduleEntries).not.toContain("page-1.lua");

      const readBack = await readConfig(tmpDir);
      expect(readBack.length).toBe(1);
      expect(readBack[0].pages.map((p) => p.pageNumber)).toEqual([0]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
