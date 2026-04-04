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
  byPosition?: boolean;
  all?: boolean;
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

  if (options.all && options.byPosition) {
    throw new GridError(
      "Cannot use --all with --by-position. Use --all to broadcast by type, or --by-position for different configs per grid position.",
    );
  }

  const configTypes = filteredConfigs.map((c) => c.module.type);
  const duplicateConfigTypes = configTypes.filter(
    (t, i) => configTypes.indexOf(t) !== i,
  );
  if (!options.byPosition && duplicateConfigTypes.length > 0) {
    const hint = options.all
      ? "Remove duplicate module types or use --by-position for different configs per position."
      : "Use --by-position for configs with duplicate module types.";
    throw new GridError(
      `Multiple modules of same type in config: ${[...new Set(duplicateConfigTypes)].join(", ")}. ${hint}`,
    );
  }

  if (options.dryRun) {
    log.info("\n[Dry run] Would push configuration to device.");
    log.info("Modules in configuration:");
    for (const config of configs) {
      log.info(
        `  - ${config.module.type} at (${config.module.dx}, ${config.module.dy})`,
      );
    }
    if (options.all) {
      log.info(
        "[--all] Would broadcast each config to every connected module of the same type.",
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

    let pushedCount = 0;

    if (options.byPosition) {
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
          `\nPushing to ${config.module.type} at (${deviceModule.dx}, ${deviceModule.dy})...`,
        );
        await device.sendModuleConfig(config, deviceModule);
        pushedCount++;
      }
    } else if (options.all) {
      for (const config of filteredConfigs) {
        const targets = modules.filter((m) => m.type === config.module.type);
        if (targets.length === 0) {
          log.warn(
            `Module type ${config.module.type} not found on device. Skipping.`,
          );
          continue;
        }
        log.info(
          `\n[--all] Pushing ${config.module.type} config to ${targets.length} module(s)...`,
        );
        for (const deviceModule of targets) {
          log.info(
            `  → ${config.module.type} at (${deviceModule.dx}, ${deviceModule.dy})`,
          );
          await device.sendModuleConfig(config, deviceModule);
          pushedCount++;
        }
      }
    } else {
      // Match by type (default) - find first device module with matching type
      const deviceTypes = modules.map((m) => m.type);
      const duplicateDeviceTypes = deviceTypes.filter(
        (t, i) => deviceTypes.indexOf(t) !== i,
      );
      if (duplicateDeviceTypes.length > 0) {
        log.warn(
          `Multiple modules of same type on device: ${[...new Set(duplicateDeviceTypes)].join(", ")}. ` +
            `Only the first match per type will receive the config. Use --all to push to all, or --by-position for precise control.`,
        );
      }

      for (const config of filteredConfigs) {
        const deviceModule = modules.find((m) => m.type === config.module.type);

        if (!deviceModule) {
          log.warn(
            `Module type ${config.module.type} not found on device. Skipping.`,
          );
          continue;
        }

        log.info(
          `\nPushing to ${config.module.type} at (${deviceModule.dx}, ${deviceModule.dy})...`,
        );
        await device.sendModuleConfig(config, deviceModule);
        pushedCount++;
      }
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
