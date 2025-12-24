import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { writeConfig } from "../src/config/writer.js";
import { readConfig } from "../src/config/reader.js";
import { getEventDescriptors, getEventTypeFromName } from "../src/device/events.js";
import type { ModuleConfig } from "../src/device/types.js";

function buildModuleConfig(): ModuleConfig {
  const elementType = "button";
  const descriptors = getEventDescriptors(elementType);
  const eventTypeInit = getEventTypeFromName(elementType, "init");
  const eventTypeButton = getEventTypeFromName(elementType, "button");
  if (eventTypeInit === null || eventTypeButton === null) {
    throw new Error("Missing event types for test");
  }

  const events = [];
  for (let elementIndex = 0; elementIndex < 2; elementIndex++) {
    for (const descriptor of descriptors) {
      const actions = [] as { short: string; name?: string; code: string }[];
      if (elementIndex === 0 && descriptor.value === eventTypeInit) {
        actions.push({ short: "log", code: "print('init')" });
      }
      if (elementIndex === 1 && descriptor.value === eventTypeButton) {
        actions.push({ short: "log", code: "print('button')" });
      }
      events.push({
        elementIndex,
        eventType: descriptor.value,
        actions,
      });
    }
  }

  return {
    module: {
      dx: 0,
      dy: 0,
      type: "TEST",
      typeId: 999,
      firmware: { major: 1, minor: 0, patch: 0 },
      elementCount: 2,
    },
    pages: [{ pageNumber: 0, events }],
  };
}

describe("config layout", () => {
  it("writes a compact layout and reads it back", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grid-config-"));
    try {
      const config = buildModuleConfig();
      await writeConfig([config], tmpDir);

      const modules = await fs.readdir(tmpDir);
      expect(modules.length).toBe(1);

      const moduleDir = path.join(tmpDir, modules[0]);
      const moduleEntries = await fs.readdir(moduleDir);
      expect(moduleEntries).toContain("module.json");
      expect(moduleEntries).toContain("page-0.lua");

      const readBack = await readConfig(tmpDir);
      expect(readBack.length).toBe(1);
      expect(readBack[0].module.type).toBe("TEST");
      expect(readBack[0].pages.length).toBe(1);

      const page = readBack[0].pages[0];
      const initEvent = page.events.find(
        (event) => event.elementIndex === 0 && event.actions.some((a) => a.code.includes("init")),
      );
      const buttonEvent = page.events.find(
        (event) => event.elementIndex === 1 && event.actions.some((a) => a.code.includes("button")),
      );

      expect(initEvent).toBeTruthy();
      expect(buttonEvent).toBeTruthy();

      const emptyEvent = page.events.find(
        (event) => event.elementIndex === 0 && event.actions.length === 0,
      );
      expect(emptyEvent).toBeTruthy();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
