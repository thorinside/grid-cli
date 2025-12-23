import * as fs from "fs/promises";
import * as path from "path";
import { parseLuaFile, validateActions } from "./parser.js";
import {
  EventType,
  EVENT_NAMES,
  type ConfigManifest,
  type ModuleManifest,
  type PageManifest,
  type ModuleConfig,
  type PageConfig,
  type EventConfig,
  type ModuleInfo,
} from "../device/types.js";
import { ConfigError, ValidationError } from "../utils/errors.js";
import * as log from "../utils/logger.js";

/**
 * Validate that a path stays within a base directory (prevent path traversal)
 */
function assertPathWithinBase(targetPath: string, baseDir: string, description: string): void {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(baseDir);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
    throw new ConfigError(`Path traversal detected in ${description}: ${targetPath}`);
  }
}

/**
 * Reverse lookup for event names to types
 */
const EVENT_NAME_TO_TYPE: Record<string, EventType> = {};
for (const [type, name] of Object.entries(EVENT_NAMES)) {
  EVENT_NAME_TO_TYPE[name] = Number(type) as EventType;
}

/**
 * Helper to get error message safely
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Helper to parse JSON with better error messages
 */
function parseJson<T>(content: string, filePath: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigError(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw new ConfigError(`Failed to parse ${filePath}: ${getErrorMessage(error)}`);
  }
}

/**
 * Read configuration manifest
 */
export async function readManifest(baseDir: string): Promise<ConfigManifest> {
  const manifestPath = path.join(baseDir, "manifest.json");

  try {
    const content = await fs.readFile(manifestPath, "utf-8");
    return parseJson<ConfigManifest>(content, manifestPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new ConfigError(`Manifest not found: ${manifestPath}`);
    }
    throw new ConfigError(`Failed to read manifest: ${getErrorMessage(error)}`);
  }
}

/**
 * Read module manifest
 */
export async function readModuleManifest(moduleDir: string): Promise<ModuleManifest> {
  const manifestPath = path.join(moduleDir, "module.json");

  try {
    const content = await fs.readFile(manifestPath, "utf-8");
    const manifest = parseJson<ModuleManifest>(content, manifestPath);

    // Validate position array
    if (!Array.isArray(manifest.position) || manifest.position.length < 2) {
      throw new ConfigError(`Invalid position in ${manifestPath}: expected [x, y] array`);
    }
    if (typeof manifest.position[0] !== "number" || typeof manifest.position[1] !== "number") {
      throw new ConfigError(`Invalid position in ${manifestPath}: coordinates must be numbers`);
    }
    if (!Number.isInteger(manifest.position[0]) || !Number.isInteger(manifest.position[1])) {
      throw new ConfigError(`Invalid position in ${manifestPath}: coordinates must be integers`);
    }

    return manifest;
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new ConfigError(`Module manifest not found: ${manifestPath}`);
    }
    throw new ConfigError(`Failed to read module manifest: ${getErrorMessage(error)}`);
  }
}

/**
 * Read page manifest
 */
export async function readPageManifest(pageDir: string): Promise<PageManifest> {
  const manifestPath = path.join(pageDir, "page.json");

  try {
    const content = await fs.readFile(manifestPath, "utf-8");
    return parseJson<PageManifest>(content, manifestPath);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new ConfigError(`Page manifest not found: ${manifestPath}`);
    }
    throw new ConfigError(`Failed to read page manifest: ${getErrorMessage(error)}`);
  }
}

/**
 * Read a single LUA event file
 */
export async function readEventFile(filePath: string): Promise<EventConfig | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const actions = parseLuaFile(content);

    // Extract event type from filename
    const filename = path.basename(filePath, ".lua");
    const eventType = EVENT_NAME_TO_TYPE[filename];

    if (eventType === undefined) {
      log.warn(`Unknown event type: ${filename}`);
      return null;
    }

    // Extract element index from parent directory name
    const elementDir = path.basename(path.dirname(filePath));
    const elementMatch = elementDir.match(/^element-(\d+)/);
    const elementIndex = elementMatch ? parseInt(elementMatch[1], 10) : 0;

    return {
      elementIndex,
      eventType,
      actions,
    };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw new ConfigError(`Event file not found: ${filePath}`);
    }
    throw new ConfigError(`Failed to read event file ${filePath}: ${getErrorMessage(error)}`);
  }
}

/**
 * Read a complete module configuration from disk
 */
export async function readModuleConfig(moduleDir: string): Promise<ModuleConfig> {
  // Read module manifest
  const moduleManifest = await readModuleManifest(moduleDir);

  const moduleInfo: ModuleInfo = {
    dx: moduleManifest.position[0],
    dy: moduleManifest.position[1],
    type: moduleManifest.type,
    typeId: moduleManifest.typeId,
    firmware: moduleManifest.firmware,
    elementCount: moduleManifest.elements.length,
  };

  const pages: PageConfig[] = [];

  // Find page directories
  const entries = await fs.readdir(moduleDir, { withFileTypes: true });
  const pageDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("page-"))
    .map((e) => e.name)
    .sort();

  for (const pageDirName of pageDirs) {
    const pageDir = path.join(moduleDir, pageDirName);
    const pageManifest = await readPageManifest(pageDir);

    const events: EventConfig[] = [];

    // Find element directories
    const pageEntries = await fs.readdir(pageDir, { withFileTypes: true });
    const elementDirs = pageEntries
      .filter((e) => e.isDirectory() && e.name.startsWith("element-"))
      .map((e) => e.name)
      .sort();

    for (const elementDirName of elementDirs) {
      const elementDir = path.join(pageDir, elementDirName);

      // Find LUA files
      const elementEntries = await fs.readdir(elementDir, { withFileTypes: true });
      const luaFiles = elementEntries
        .filter((e) => e.isFile() && e.name.endsWith(".lua"))
        .map((e) => e.name);

      for (const luaFile of luaFiles) {
        const luaPath = path.join(elementDir, luaFile);
        const eventConfig = await readEventFile(luaPath);

        if (eventConfig) {
          events.push(eventConfig);
        }
      }
    }

    pages.push({
      pageNumber: pageManifest.page,
      events,
    });
  }

  return {
    module: moduleInfo,
    pages,
  };
}

/**
 * Read complete configuration from disk
 */
export async function readConfig(baseDir: string): Promise<ModuleConfig[]> {
  const manifest = await readManifest(baseDir);
  const configs: ModuleConfig[] = [];

  for (const moduleEntry of manifest.modules) {
    const moduleDir = path.join(baseDir, moduleEntry.path);
    assertPathWithinBase(moduleDir, baseDir, "module path");
    const config = await readModuleConfig(moduleDir);
    configs.push(config);

    log.info(`Loaded configuration for ${config.module.type} at (${config.module.dx}, ${config.module.dy})`);
  }

  return configs;
}

/**
 * Validate a complete configuration
 */
export function validateConfig(configs: ModuleConfig[]): void {
  const errors: string[] = [];

  for (const config of configs) {
    const moduleId = `${config.module.type}(${config.module.dx},${config.module.dy})`;

    for (const page of config.pages) {
      for (const event of page.events) {
        try {
          validateActions(event.actions);
        } catch (error) {
          if (error instanceof ValidationError) {
            for (const e of error.errors) {
              errors.push(`${moduleId}/page-${page.pageNumber}/element-${event.elementIndex}/${EVENT_NAMES[event.eventType]}: ${e}`);
            }
          } else {
            errors.push(`${moduleId}/page-${page.pageNumber}/element-${event.elementIndex}/${EVENT_NAMES[event.eventType]}: ${getErrorMessage(error)}`);
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError("Configuration validation failed", errors);
  }
}

/**
 * Check if a directory contains a valid configuration
 */
export async function isValidConfigDir(baseDir: string): Promise<boolean> {
  try {
    const manifestPath = path.join(baseDir, "manifest.json");
    await fs.access(manifestPath);
    return true;
  } catch {
    return false;
  }
}
