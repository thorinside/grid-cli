import * as fs from "fs/promises";
import * as path from "path";
import { deviceManager } from "../device/manager.js";
import { writeConfig } from "../config/writer.js";
import * as log from "../utils/logger.js";
import { GridError } from "../utils/errors.js";
import { parsePageList } from "./pages.js";

export interface PullOptions {
  device?: string;
  force?: boolean;
  pages?: string;
  skipPages?: string;
}

/**
 * Pull configuration from device to disk
 */
export async function pullCommand(
  outputDir: string,
  options: PullOptions,
): Promise<void> {
  // Resolve output directory
  const resolvedDir = path.resolve(outputDir);

  // Check if directory exists
  try {
    const stats = await fs.stat(resolvedDir);
    if (stats.isDirectory()) {
      const entries = await fs.readdir(resolvedDir);
      if (entries.length > 0 && !options.force) {
        throw new GridError(
          `Directory ${resolvedDir} is not empty. Use --force to overwrite.`,
        );
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // Directory doesn't exist, that's fine
  }

  let device;
  try {
    if (options.pages && options.skipPages) {
      throw new GridError("Use either --pages or --skip-pages, not both.");
    }

    const includePages = options.pages ? parsePageList(options.pages) : null;
    const excludePages = options.skipPages
      ? parsePageList(options.skipPages)
      : null;

    // Connect to device
    device = await deviceManager.connect(options.device);

    const modules = device.getModules();
    if (modules.length === 0) {
      throw new GridError(
        "No modules found on device. Is the Grid connected properly?",
      );
    }

    log.info(`\nFetching configuration from ${modules.length} module(s)...\n`);

    // Fetch all module configurations
    const configs = [];
    for (const module of modules) {
      log.info(`\nFetching ${module.type} at (${module.dx}, ${module.dy})...`);
      const config = await device.fetchModuleConfig(module, {
        includePages,
        excludePages,
      });
      configs.push(config);
    }

    // Write to disk
    log.info(`\nWriting configuration to ${resolvedDir}...`);
    await writeConfig(configs, resolvedDir);

    // Summary
    let totalEvents = 0;
    let eventsWithCode = 0;
    for (const config of configs) {
      for (const page of config.pages) {
        for (const event of page.events) {
          totalEvents++;
          if (event.actions.length > 0) {
            eventsWithCode++;
          }
        }
      }
    }

    log.info("");
    log.success(`Successfully pulled configuration!`);
    log.info(`  Modules: ${modules.length}`);
    log.info(`  Events with code: ${eventsWithCode} / ${totalEvents}`);
    log.info(`  Output: ${resolvedDir}`);
  } finally {
    // Always disconnect
    if (device) {
      await deviceManager.disconnect(device);
    }
  }
}
