import * as path from "path";
import { deviceManager } from "../device/manager.js";
import {
  readConfig,
  validateConfig,
  isValidConfigDir,
} from "../config/reader.js";
import * as log from "../utils/logger.js";
import { GridError, ValidationError } from "../utils/errors.js";
import { parsePageList } from "./pages.js";

export interface PushOptions {
  device?: string;
  dryRun?: boolean;
  clear?: boolean;
  noStore?: boolean;
  pages?: string;
  skipPages?: string;
}

/**
 * Push configuration from disk to device
 */
export async function pushCommand(
  inputDir: string,
  options: PushOptions,
): Promise<void> {
  // Resolve input directory
  const resolvedDir = path.resolve(inputDir);

  // Check if directory is a valid config
  if (!(await isValidConfigDir(resolvedDir))) {
    throw new GridError(
      `${resolvedDir} is not a valid configuration directory. Missing manifest.json.`,
    );
  }

  // Read configuration from disk
  log.info(`Reading configuration from ${resolvedDir}...`);
  const configs = await readConfig(resolvedDir);

  if (configs.length === 0) {
    throw new GridError("No modules found in configuration.");
  }

  // Validate configuration
  log.info("Validating configuration...");
  try {
    validateConfig(configs);
    log.success("Configuration is valid.");
  } catch (error) {
    if (error instanceof ValidationError) {
      log.error("Configuration validation failed:");
      for (const e of error.errors) {
        log.error(`  - ${e}`);
      }
      throw new GridError("Fix validation errors before pushing.");
    }
    throw error;
  }

  // Count events to push
  if (options.pages && options.skipPages) {
    throw new GridError("Use either --pages or --skip-pages, not both.");
  }

  const includePages = options.pages ? parsePageList(options.pages) : null;
  const excludePages = options.skipPages
    ? parsePageList(options.skipPages)
    : null;

  const filteredConfigs = configs.map((config) => {
    const pages = config.pages.filter((page) => {
      if (includePages) return includePages.has(page.pageNumber);
      if (excludePages) return !excludePages.has(page.pageNumber);
      return true;
    });
    return {
      ...config,
      pages,
    };
  });

  let totalEvents = 0;
  for (const config of filteredConfigs) {
    for (const page of config.pages) {
      totalEvents += page.events.length;
    }
  }

  log.info(`\nConfiguration summary:`);
  log.info(`  Modules: ${configs.length}`);
  log.info(`  Total events: ${totalEvents}`);

  if (options.dryRun) {
    log.info("\n[Dry run] Would push configuration to device.");
    log.info("Modules in configuration:");
    for (const config of configs) {
      log.info(
        `  - ${config.module.type} at (${config.module.dx}, ${config.module.dy})`,
      );
    }
    return;
  }

  let device;
  try {
    // Connect to device
    device = await deviceManager.connect(options.device);

    const modules = device.getModules();
    if (modules.length === 0) {
      throw new GridError(
        "No modules found on device. Is the Grid connected properly?",
      );
    }

    if (options.clear) {
      log.info("\n[--clear] Erasing device configuration before push...");
      await device.eraseNvm();
      log.info("Waiting for device to restart...");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await device.waitForModules(5000);
    }

    // Check that modules match
    let pushedCount = 0;
    for (const config of filteredConfigs) {
      const deviceModule = modules.find(
        (m) => m.dx === config.module.dx && m.dy === config.module.dy,
      );

      if (!deviceModule) {
        log.warn(
          `Module ${config.module.type} at (${config.module.dx}, ${config.module.dy}) not found on device. Skipping.`,
        );
        continue;
      }

      if (deviceModule.type !== config.module.type) {
        log.warn(
          `Module type mismatch at (${config.module.dx}, ${config.module.dy}): ` +
            `config has ${config.module.type}, device has ${deviceModule.type}. Skipping.`,
        );
        continue;
      }

      log.info(
        `\nPushing to ${config.module.type} at (${config.module.dx}, ${config.module.dy})...`,
      );
      await device.sendModuleConfig(config);
      pushedCount++;
    }

    if (pushedCount === 0) {
      throw new GridError(
        "No modules were pushed. Check that device modules match configuration.",
      );
    }

    // Store to flash unless --no-store
    if (!options.noStore) {
      log.info("");
      await device.storeToFlash();
    } else {
      log.info("\n[--no-store] Configuration NOT saved to flash.");
      log.info("Changes will be lost on device reset.");
    }

    log.info("");
    log.success(
      `Successfully pushed configuration to ${pushedCount} module(s)!`,
    );
  } finally {
    // Always disconnect
    if (device) {
      await deviceManager.disconnect(device);
    }
  }
}
