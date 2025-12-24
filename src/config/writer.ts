import * as fs from "fs/promises";
import * as path from "path";
import { formatActionBlock } from "./formatter.js";
import { parseDeviceFormat } from "./parser.js";
import type { Action, ModuleConfig } from "../device/types.js";
import * as log from "../utils/logger.js";
import type { ModuleFile } from "./schema.js";
import { getEventDescriptors, getEventNameForType } from "../device/events.js";
import { getModuleElementList, unwrapScript } from "../protocol/codec.js";
import { GridScript } from "../protocol/script.js";
import { ConfigError } from "../utils/errors.js";

const TOOL_VERSION = "0.1.0";
const MODULE_VERSION = "1.0.0";
const MODULE_FILE_NAME = "module.json";

/**
 * Sanitize a string for use as a directory/file name component.
 * Prevents path traversal attacks and ensures cross-platform compatibility.
 */
function sanitizePathComponent(value: string): string {
  // First, take only the basename to prevent any path separators from causing traversal
  const basename = path.basename(value);

  // Then slugify: lowercase, replace non-alphanumeric with dashes, trim dashes
  return basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function slugify(value: string): string {
  // Validate that value doesn't contain path separators before slugifying
  if (value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new ConfigError(
      `Invalid module type contains path characters: ${value}`,
    );
  }

  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function formatModuleDirName(index: number, type: string): string {
  const idx = index.toString().padStart(2, "0");
  return `${idx}-${slugify(type)}`;
}

function buildPageFrontMatter(pageNumber: number): string[] {
  return [`-- grid: page=${pageNumber}`];
}

function formatEventHeader(options: {
  elementIndex: number;
  eventName: string;
}): string {
  const { elementIndex, eventName } = options;
  return `-- grid:event element=${elementIndex} event=${eventName}`;
}

function normalizeCode(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}

function actionsMatch(a: Action[], b: Action[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left.short !== right.short) return false;
    if ((left.name ?? "") !== (right.name ?? "")) return false;
    if (normalizeCode(left.code) !== normalizeCode(right.code)) return false;
  }
  return true;
}

function humanizeActions(actions: Action[]): Action[] {
  return actions.map((action) => ({
    ...action,
    code: GridScript.humanize(action.code),
  }));
}

export async function writeConfig(
  configs: ModuleConfig[],
  baseDir: string,
): Promise<void> {
  await fs.mkdir(baseDir, { recursive: true });

  let moduleIndex = 0;
  for (const config of configs) {
    moduleIndex++;
    const module = config.module;
    const moduleDir = path.join(
      baseDir,
      formatModuleDirName(moduleIndex, module.type),
    );
    await fs.mkdir(moduleDir, { recursive: true });

    const elementTypes = new Map<number, string>();
    const protocolElements = getModuleElementList(module.type);
    if (protocolElements) {
      for (let i = 0; i < protocolElements.length; i++) {
        const elementType = protocolElements[i];
        if (typeof elementType !== "string" || elementType.length === 0) {
          continue;
        }
        elementTypes.set(i, elementType);
      }
    }
    if (elementTypes.size === 0) {
      for (let i = 0; i < module.elementCount; i++) {
        elementTypes.set(i, "button");
      }
    }

    const defaultActionsByElementType = new Map<
      string,
      Map<number, Action[]>
    >();
    const getDefaultActions = (
      elementType: string,
      eventType: number,
    ): Action[] | null => {
      if (!defaultActionsByElementType.has(elementType)) {
        const descriptorMap = new Map<number, Action[]>();
        const descriptors = getEventDescriptors(elementType);
        for (const descriptor of descriptors) {
          if (!descriptor.defaultConfig) {
            continue;
          }
          const actions = parseDeviceFormat(
            unwrapScript(descriptor.defaultConfig),
          );
          descriptorMap.set(descriptor.value, actions);
        }
        defaultActionsByElementType.set(elementType, descriptorMap);
      }
      const byEvent = defaultActionsByElementType.get(elementType);
      return byEvent?.get(eventType) ?? null;
    };

    const writtenPages: number[] = [];
    const writtenFiles: string[] = [];

    try {
      for (const page of config.pages) {
        const eventBlocks = page.events
          .filter((event) => {
            if (event.actions.length === 0) {
              return false;
            }
            const elementType =
              elementTypes.get(event.elementIndex) || "button";
            const defaultActions = getDefaultActions(
              elementType,
              event.eventType,
            );
            if (defaultActions && actionsMatch(event.actions, defaultActions)) {
              return false;
            }
            return true;
          })
          .sort((a, b) => {
            if (a.elementIndex !== b.elementIndex) {
              return a.elementIndex - b.elementIndex;
            }
            return a.eventType - b.eventType;
          });

        // Skip pages with no non-default events
        if (eventBlocks.length === 0) {
          continue;
        }

        const pageLines: string[] = [];
        pageLines.push(...buildPageFrontMatter(page.pageNumber));
        pageLines.push("");

        let firstEvent = true;
        for (const event of eventBlocks) {
          if (!firstEvent) {
            pageLines.push(
              "-- ============================================================",
            );
            pageLines.push("");
          }
          const elementType = elementTypes.get(event.elementIndex) || "button";
          const eventName = getEventNameForType(elementType, event.eventType);
          pageLines.push(
            formatEventHeader({
              elementIndex: event.elementIndex,
              eventName,
            }),
          );
          pageLines.push(formatActionBlock(humanizeActions(event.actions)));
          pageLines.push("");
          firstEvent = false;
        }

        const pagePath = path.join(moduleDir, `page-${page.pageNumber}.lua`);
        await fs.writeFile(pagePath, pageLines.join("\n").trimEnd() + "\n");
        writtenFiles.push(pagePath);
        writtenPages.push(page.pageNumber);
      }

      // If no pages were written, write an empty page-0.lua to ensure round-trip works
      if (writtenPages.length === 0) {
        const emptyPagePath = path.join(moduleDir, "page-0.lua");
        const emptyPageContent = [
          "-- grid: page=0",
          "",
          "-- All events use default configuration",
        ].join("\n");
        await fs.writeFile(emptyPagePath, emptyPageContent + "\n");
        writtenFiles.push(emptyPagePath);
        writtenPages.push(0);
        log.warn(
          `No non-default events found for ${module.type} at (${module.dx}, ${module.dy}); created empty page-0.lua.`,
        );
      }

      const pagesForManifest = writtenPages.sort((a, b) => a - b);

      const moduleFile: ModuleFile = {
        version: MODULE_VERSION,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
        toolVersion: TOOL_VERSION,
        index: moduleIndex,
        position: [module.dx, module.dy],
        type: module.type,
        typeId: module.typeId,
        firmware: module.firmware,
        elements: Array.from(elementTypes.entries())
          .map(([index, type]) => ({ index, type }))
          .sort((a, b) => a.index - b.index),
        pages: pagesForManifest,
      };

      const moduleFilePath = path.join(moduleDir, MODULE_FILE_NAME);
      await fs.writeFile(moduleFilePath, JSON.stringify(moduleFile, null, 2));
      writtenFiles.push(moduleFilePath);
    } catch (error) {
      // Clean up partially written files on error
      for (const filePath of writtenFiles) {
        try {
          await fs.unlink(filePath);
        } catch {
          // Ignore cleanup errors
        }
      }
      throw new ConfigError(
        `Failed to write configuration for ${module.type}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  log.success(`Configuration written to ${baseDir}`);
}
