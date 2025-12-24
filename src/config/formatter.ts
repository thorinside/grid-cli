import type { Action, ModuleInfo, EventType } from "../device/types.js";
import { getEventNameForType } from "../device/events.js";
import { getActionDisplayName } from "./action-names.js";

/**
 * Format actions as readable LUA file content
 */
export function formatLuaFile(
  actions: Action[],
  options: {
    module?: ModuleInfo;
    element?: number;
    elementType?: string;
    eventType?: EventType;
    page?: number;
    frontMatter?: string[];
  } = {},
): string {
  const lines: string[] = [];

  if (options.frontMatter && options.frontMatter.length > 0) {
    lines.push(...options.frontMatter);
  }

  // Header comment
  lines.push("-- Grid Configuration");

  if (options.module) {
    lines.push(
      `-- Module: ${options.module.type} at (${options.module.dx}, ${options.module.dy})`,
    );
  }

  if (options.element !== undefined) {
    lines.push(`-- Element: ${options.element}`);
  }

  if (options.eventType !== undefined) {
    const elementType = options.elementType ?? "button";
    lines.push(
      `-- Event: ${getEventNameForType(elementType, options.eventType)}`,
    );
  }

  if (options.page !== undefined) {
    lines.push(`-- Page: ${options.page}`);
  }

  lines.push("");

  // Format each action
  let first = true;
  for (const action of actions) {
    if (!first) {
      lines.push(
        "-- ------------------------------------------------------------",
      );
    }
    const displayName = getActionDisplayName(action.short);
    if (displayName) {
      lines.push(`-- action: ${displayName} (${action.short})`);
    }

    const meta = action.name ? `${action.short}#${action.name}` : action.short;
    lines.push(`--[[@${meta}]]`);
    lines.push(action.code.trim());
    lines.push("");
    first = false;
  }

  return lines.join("\n");
}

/**
 * Format actions as a block without file-level headers
 */
export function formatActionBlock(actions: Action[]): string {
  const lines: string[] = [];

  let first = true;
  for (const action of actions) {
    if (!first) {
      lines.push(
        "-- ------------------------------------------------------------",
      );
    }
    const displayName = getActionDisplayName(action.short);
    if (displayName) {
      lines.push(`-- action: ${displayName} (${action.short})`);
    }

    const meta = action.name ? `${action.short}#${action.name}` : action.short;
    lines.push(`--[[@${meta}]]`);
    lines.push(action.code.trim());
    lines.push("");
    first = false;
  }

  return lines.join("\n").trimEnd();
}

/**
 * Generate filename for an event
 */
export function getEventFilename(
  eventType: EventType,
  elementType: string,
): string {
  return `${getEventNameForType(elementType, eventType)}.lua`;
}

/**
 * Generate directory name for an element
 */
export function getElementDirName(
  elementIndex: number,
  elementType: string,
): string {
  return `element-${elementIndex.toString().padStart(2, "0")}-${elementType}`;
}

/**
 * Generate directory name for a page
 */
export function getPageDirName(pageNumber: number): string {
  return `page-${pageNumber}`;
}

/**
 * Generate directory name for a module
 */
export function getModuleDirName(dx: number, dy: number): string {
  return `module-${dx}-${dy}`;
}
