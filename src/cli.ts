#!/usr/bin/env node

import { Command } from "commander";
import { devicesCommand } from "./commands/devices.js";
import { clearCommand, type ClearOptions } from "./commands/clear.js";
import { pullCommand, type PullOptions } from "./commands/pull.js";
import { pushCommand, type PushOptions } from "./commands/push.js";
import { initProtocol } from "./protocol/index.js";
import * as log from "./utils/logger.js";
import { GridError } from "./utils/errors.js";

// Initialize protocol module (suppresses debug output)
try {
  await initProtocol();
} catch (error) {
  log.error(
    "Failed to initialize protocol module:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
}

const program = new Command();

program
  .name("grid-cli")
  .description("CLI tool for Grid controller configuration management")
  .version("0.1.0")
  .option("-v, --verbose", "Enable verbose output")
  .hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) {
      log.setVerbose(true);
    }
  });

program
  .command("devices")
  .description("List connected Grid devices")
  .action(async () => {
    try {
      await devicesCommand();
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("clear")
  .description("Erase device configuration (factory reset)")
  .option(
    "-d, --device <path>",
    "Serial port path (uses first device if not specified)",
  )
  .option("--dry-run", "Show what would be done without making changes")
  .action(async (options: ClearOptions) => {
    try {
      await clearCommand(options);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("pull")
  .description("Download configuration from device to files")
  .argument("<directory>", "Output directory for configuration files")
  .option(
    "-d, --device <path>",
    "Serial port path (uses first device if not specified)",
  )
  .option("-f, --force", "Overwrite existing files")
  .option("--pages <list>", "Only pull specific pages (e.g. 0,2-3)")
  .option("--skip-pages <list>", "Skip specific pages (e.g. 1,3)")
  .action(async (directory: string, options: PullOptions) => {
    try {
      await pullCommand(directory, options);
    } catch (error) {
      handleError(error);
    }
  });

program
  .command("push")
  .description("Upload configuration from files to device")
  .argument("<directory>", "Input directory containing configuration files")
  .option(
    "-d, --device <path>",
    "Serial port path (uses first device if not specified)",
  )
  .option(
    "--dry-run",
    "Validate and show what would be pushed without making changes",
  )
  .option("--clear", "Erase device configuration before pushing")
  .option("--no-store", "Don't save to flash (changes lost on reset)")
  .option("--pages <list>", "Only push specific pages (e.g. 0,2-3)")
  .option("--skip-pages <list>", "Skip specific pages (e.g. 1,3)")
  .action(async (directory: string, options: PushOptions) => {
    try {
      await pushCommand(directory, options);
    } catch (error) {
      handleError(error);
    }
  });

function handleError(error: unknown): void {
  if (error instanceof GridError) {
    log.error(error.message);
  } else if (error instanceof Error) {
    log.error(error.message);
    if (log.isVerbose()) {
      console.error(error.stack);
    }
  } else {
    log.error(String(error));
  }
  process.exit(1);
}

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  log.error("Uncaught exception:", error.message);
  if (log.isVerbose()) {
    console.error(error.stack);
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection:", String(reason));
  process.exit(1);
});

program.parse();
