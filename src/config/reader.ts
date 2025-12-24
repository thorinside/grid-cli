import * as fs from "fs/promises";
import * as path from "path";
import { parseDeviceFormat, parseLuaFile, validateActions } from "./parser.js";
import type {
  ModuleConfig,
  PageConfig,
  EventConfig,
  ModuleInfo,
  Action,
} from "../device/types.js";
import { ConfigError, ValidationError } from "../utils/errors.js";
import * as log from "../utils/logger.js";
import type { ModuleFile } from "./schema.js";
import {
  getEventDescriptors,
  getEventNameForType,
  getEventTypeFromName,
} from "../device/events.js";
import { unwrapScript } from "../protocol/codec.js";

const MODULE_FILE_NAME = "module.json";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseJson<T>(content: string, filePath: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigError(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw new ConfigError(
      `Failed to parse ${filePath}: ${getErrorMessage(error)}`,
    );
  }
}

async function readModuleFile(moduleDir: string): Promise<ModuleFile> {
  const manifestPath = path.join(moduleDir, MODULE_FILE_NAME);
  try {
    const content = await fs.readFile(manifestPath, "utf-8");
    return parseJson<ModuleFile>(content, manifestPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new ConfigError(`Module file not found: ${manifestPath}`);
    }
    throw error;
  }
}

/**
 * Parse front-matter from file content.
 * Front-matter lines start with "-- grid:" and can appear anywhere before
 * the first event marker. Blank lines and comments are allowed between them.
 */
function parseFrontMatter(
  content: string,
  filePath: string,
): Record<string, string> {
  const lines = content.split("\n");
  const result: Record<string, string> = {};

  for (const line of lines) {
    // Stop parsing front-matter when we hit an event marker
    if (line.match(/^\s*--\s*grid:event\s/)) {
      break;
    }

    // Skip blank lines and non-front-matter comments
    if (!line.startsWith("-- grid:")) {
      continue;
    }

    // Don't treat "-- grid:event" as front-matter
    if (line.startsWith("-- grid:event")) {
      break;
    }

    const entry = line.slice("-- grid:".length).trim();
    const [rawKey, ...rest] = entry.split("=");
    const key = rawKey.trim();
    const value = rest.join("=").trim();
    if (!key || !value) {
      throw new ConfigError(
        `Invalid front-matter line in ${filePath}: ${line}`,
      );
    }
    result[key] = value;
  }
  return result;
}

function parsePosition(value: string, filePath: string): [number, number] {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length !== 2) {
    throw new ConfigError(`Invalid position in ${filePath}`);
  }
  const dx = Number(parts[0]);
  const dy = Number(parts[1]);
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) {
    throw new ConfigError(`Invalid position in ${filePath}`);
  }
  return [dx, dy];
}

function parsePageNumberFromPath(filePath: string): number | null {
  const match = path.basename(filePath).match(/^page-(\d+)\.lua$/);
  if (!match) return null;
  return Number(match[1]);
}

function parseEventHeader(
  raw: string,
  filePath: string,
): { elementIndex: number; elementType?: string; eventName: string } {
  const entries: Record<string, string> = {};
  const pattern = /(\w+)=((?:"[^"]*")|\S+)/g;
  for (const match of raw.matchAll(pattern)) {
    const key = match[1];
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }

  const elementValue = entries.element;
  const eventName = entries.event;
  const elementType = entries.elementType;

  if (!elementValue) {
    throw new ConfigError(`Missing element in ${filePath}`);
  }
  if (!eventName) {
    throw new ConfigError(`Missing event in ${filePath}`);
  }

  const elementIndex = Number(elementValue);
  if (!Number.isInteger(elementIndex)) {
    throw new ConfigError(`Invalid element in ${filePath}`);
  }

  return { elementIndex, elementType, eventName };
}

async function readPageFile(filePath: string): Promise<{
  moduleName?: string;
  position?: [number, number];
  pageNumber: number;
  events: Array<{
    elementIndex: number;
    elementType?: string;
    eventName: string;
    actions: EventConfig["actions"];
  }>;
}> {
  const content = await fs.readFile(filePath, "utf-8");
  const frontMatter = parseFrontMatter(content, filePath);

  const moduleName = frontMatter.module;
  const position = frontMatter.position;
  const frontMatterPage = frontMatter.page ? Number(frontMatter.page) : null;
  const pageFromName = parsePageNumberFromPath(filePath);

  let pageNumber: number | null = null;
  if (Number.isInteger(frontMatterPage)) {
    pageNumber = frontMatterPage;
    if (pageFromName !== null && pageFromName !== frontMatterPage) {
      log.warn(
        `Page number mismatch in ${filePath}: front-matter ${frontMatterPage}, file name ${pageFromName}`,
      );
    }
  } else if (pageFromName !== null) {
    log.warn(
      `Missing page in ${filePath}; using ${pageFromName} from file name.`,
    );
    pageNumber = pageFromName;
  }

  if (pageNumber === null) {
    throw new ConfigError(`Missing or invalid page in ${filePath}`);
  }

  const lines = content.split("\n");
  const events: Array<{
    elementIndex: number;
    elementType?: string;
    eventName: string;
    actions: EventConfig["actions"];
  }> = [];

  let currentMeta: {
    elementIndex: number;
    elementType?: string;
    eventName: string;
  } | null = null;
  let blockLines: string[] = [];

  const flushBlock = () => {
    if (!currentMeta) return;
    const actions = parseLuaFile(blockLines.join("\n"));
    events.push({
      elementIndex: currentMeta.elementIndex,
      elementType: currentMeta.elementType,
      eventName: currentMeta.eventName,
      actions,
    });
  };

  for (const line of lines) {
    const match = line.match(/^\s*--\s*grid:event\s*(.*)$/);
    if (match) {
      flushBlock();
      currentMeta = parseEventHeader(match[1], filePath);
      blockLines = [];
      continue;
    }

    if (currentMeta) {
      blockLines.push(line);
    }
  }

  flushBlock();

  return {
    moduleName,
    position: position ? parsePosition(position, filePath) : undefined,
    pageNumber,
    events,
  };
}

function buildElementTypes(moduleFile: ModuleFile): Map<number, string> {
  const elementTypes = new Map<number, string>();
  if (moduleFile.elements && moduleFile.elements.length > 0) {
    for (const element of moduleFile.elements) {
      elementTypes.set(element.index, element.type || "button");
    }
  }
  return elementTypes;
}

function buildDefaultActionsResolver() {
  const defaultsByElementType = new Map<string, Map<number, Action[]>>();

  return (elementType: string, eventType: number): Action[] | null => {
    if (!defaultsByElementType.has(elementType)) {
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
      defaultsByElementType.set(elementType, descriptorMap);
    }
    const byEvent = defaultsByElementType.get(elementType);
    return byEvent?.get(eventType) ?? null;
  };
}

export async function readConfig(baseDir: string): Promise<ModuleConfig[]> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const moduleDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name));

  const configs: ModuleConfig[] = [];

  for (const moduleDir of moduleDirs) {
    let moduleFile: ModuleFile;
    try {
      moduleFile = await readModuleFile(moduleDir);
    } catch (error) {
      if (
        error instanceof ConfigError &&
        error.message.includes("Module file not found")
      ) {
        continue;
      }
      throw error;
    }

    const moduleInfo: ModuleInfo = {
      dx: moduleFile.position[0],
      dy: moduleFile.position[1],
      type: moduleFile.type,
      typeId: moduleFile.typeId,
      firmware: moduleFile.firmware,
      elementCount: moduleFile.elements.length,
    };

    const elementTypes = buildElementTypes(moduleFile);
    if (elementTypes.size === 0 && moduleInfo.elementCount > 0) {
      for (let i = 0; i < moduleInfo.elementCount; i++) {
        elementTypes.set(i, "button");
      }
    }

    const getDefaultActions = buildDefaultActionsResolver();
    const pageFiles = await findPageFiles(moduleDir);
    const overrides = new Map<
      number,
      Map<number, Map<number, EventConfig["actions"]>>
    >();
    const pagesFromFiles = new Set<number>();

    for (const pageFile of pageFiles) {
      const pageData = await readPageFile(pageFile);

      if (pageData.moduleName && pageData.moduleName !== moduleFile.type) {
        throw new ConfigError(
          `Module mismatch in ${pageFile}: expected ${moduleFile.type}, got ${pageData.moduleName}`,
        );
      }
      if (pageData.position) {
        const [dx, dy] = pageData.position;
        if (dx !== moduleFile.position[0] || dy !== moduleFile.position[1]) {
          throw new ConfigError(
            `Position mismatch in ${pageFile}: expected ${moduleFile.position[0]},${moduleFile.position[1]}, got ${dx},${dy}`,
          );
        }
      }

      pagesFromFiles.add(pageData.pageNumber);
      if (!overrides.has(pageData.pageNumber)) {
        overrides.set(pageData.pageNumber, new Map());
      }

      const pageOverrides = overrides.get(pageData.pageNumber)!;

      for (const eventMeta of pageData.events) {
        if (!elementTypes.has(eventMeta.elementIndex)) {
          log.warn(
            `Unknown element ${eventMeta.elementIndex} in ${pageFile}; skipping.`,
          );
          continue;
        }

        const moduleElementType =
          elementTypes.get(eventMeta.elementIndex) || "button";
        const elementType = eventMeta.elementType || moduleElementType;
        if (
          eventMeta.elementType &&
          eventMeta.elementType !== moduleElementType
        ) {
          log.warn(
            `Element type mismatch for element ${eventMeta.elementIndex} in ${pageFile}: ` +
              `module.json has ${moduleElementType}, file has ${eventMeta.elementType}`,
          );
        }

        const eventType = getEventTypeFromName(
          elementType,
          eventMeta.eventName,
        );
        if (eventType === null) {
          log.warn(
            `Unknown event type "${eventMeta.eventName}" for ${moduleFile.type} element ${eventMeta.elementIndex}`,
          );
          continue;
        }

        if (!pageOverrides.has(eventMeta.elementIndex)) {
          pageOverrides.set(eventMeta.elementIndex, new Map());
        }

        const elementOverrides = pageOverrides.get(eventMeta.elementIndex)!;
        if (elementOverrides.has(eventType)) {
          log.warn(
            `Duplicate event override for element ${eventMeta.elementIndex}, event ${eventMeta.eventName} in ${pageFile}.`,
          );
        }
        elementOverrides.set(eventType, eventMeta.actions);
      }
    }

    const declaredPages = moduleFile.pages ?? [];
    const pageSet = new Set<number>();

    if (declaredPages.length > 0) {
      for (const page of declaredPages) {
        pageSet.add(page);
      }
      for (const page of pagesFromFiles) {
        if (!pageSet.has(page)) {
          log.warn(`Page ${page} not listed in ${MODULE_FILE_NAME}; adding.`);
          pageSet.add(page);
        }
      }
    } else {
      for (const page of pagesFromFiles) {
        pageSet.add(page);
      }
    }

    if (pageSet.size === 0) {
      throw new ConfigError(`No page files found for ${moduleFile.type}`);
    }

    const pages: PageConfig[] = [];
    const sortedPages = Array.from(pageSet).sort((a, b) => a - b);
    const elementIndices = Array.from(elementTypes.keys()).sort(
      (a, b) => a - b,
    );

    for (const pageNumber of sortedPages) {
      const events: EventConfig[] = [];
      const pageOverrides = overrides.get(pageNumber);

      for (const elementIndex of elementIndices) {
        const elementType = elementTypes.get(elementIndex) || "button";
        const descriptors = getEventDescriptors(elementType);

        for (const descriptor of descriptors) {
          const elementOverrides = pageOverrides?.get(elementIndex);
          const defaultActions = getDefaultActions(
            elementType,
            descriptor.value,
          );
          const actions =
            elementOverrides?.get(descriptor.value) ?? defaultActions ?? [];
          events.push({
            elementIndex,
            eventType: descriptor.value,
            actions,
          });
        }
      }

      pages.push({ pageNumber, events });
    }

    configs.push({
      module: moduleInfo,
      pages,
    });

    log.info(
      `Loaded configuration for ${moduleInfo.type} at (${moduleInfo.dx}, ${moduleInfo.dy})`,
    );
  }

  if (configs.length === 0) {
    throw new ConfigError(
      `No ${MODULE_FILE_NAME} files found under ${baseDir}`,
    );
  }

  return configs;
}

async function findPageFiles(baseDir: string): Promise<string[]> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^page-\d+\.lua$/.test(entry.name))
    .map((entry) => path.join(baseDir, entry.name));
}

export function validateConfig(configs: ModuleConfig[]): void {
  const errors: string[] = [];

  for (const config of configs) {
    const moduleId = `${config.module.type}(${config.module.dx},${config.module.dy})`;
    for (const page of config.pages) {
      for (const event of page.events) {
        try {
          validateActions(event.actions);
        } catch (error) {
          const eventName = getEventNameForType("button", event.eventType);
          if (error instanceof ValidationError) {
            for (const e of error.errors) {
              errors.push(
                `${moduleId}/page-${page.pageNumber}/element-${event.elementIndex}/${eventName}: ${e}`,
              );
            }
          } else {
            errors.push(
              `${moduleId}/page-${page.pageNumber}/element-${event.elementIndex}/${eventName}: ${getErrorMessage(error)}`,
            );
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError("Configuration validation failed", errors);
  }
}

export async function isValidConfigDir(baseDir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(baseDir, entry.name, MODULE_FILE_NAME);
      try {
        await fs.access(manifestPath);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return false;
  }
}
