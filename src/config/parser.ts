import type { Action } from "../device/types.js";
import { ValidationError } from "../utils/errors.js";
import { GridScript } from "../protocol/script.js";

/**
 * Parse readable LUA file content into Action objects
 */
export function parseLuaFile(content: string): Action[] {
  const actions: Action[] = [];
  const lines = content.split("\n");

  let currentAction: Action | null = null;
  let codeLines: string[] = [];

  for (const line of lines) {
    // Check for action header: --[[@short#name]] with optional inline code
    // Also supports legacy --[[ @action short "name" ]]
    const shorthandMatch = line.match(/^\s*--\[\[@([^\]]+)\]\]\s*(.*)$/);
    const headerMatch = line.match(
      /^\s*--\[\[\s*@action\s+(\S+)(?:\s+"([^"]*)")?\s*\]\]\s*$/,
    );

    const parsed = (() => {
      if (shorthandMatch) {
        const meta = shorthandMatch[1];
        const parts = meta.split(/#(.*)/, 2);
        return {
          short: parts[0],
          name: parts[1],
          inlineCode: shorthandMatch[2] || "",
        };
      }
      if (headerMatch) {
        return { short: headerMatch[1], name: headerMatch[2], inlineCode: "" };
      }
      return null;
    })();

    if (parsed) {
      // Save previous action if any
      if (currentAction) {
        currentAction.code = codeLines.join("\n").trim();
        if (currentAction.code) {
          actions.push(currentAction);
        }
      }

      // Start new action
      currentAction = { short: parsed.short, name: parsed.name, code: "" };
      codeLines = [];
      // If there's inline code after the header, add it
      if (parsed.inlineCode.trim()) {
        codeLines.push(parsed.inlineCode);
      }
    } else if (currentAction) {
      const isBlank = /^\s*$/.test(line);
      const isIgnored =
        line.startsWith("-- Grid Configuration") ||
        line.startsWith("-- Module:") ||
        line.startsWith("-- Element:") ||
        line.startsWith("-- Event:") ||
        line.startsWith("-- Page:") ||
        line.startsWith("-- grid:") ||
        line.startsWith("-- grid:event") ||
        line.startsWith("-- action:") ||
        /^\s*--\s*[-=]{3,}/.test(line);

      if (!isIgnored && !isBlank) {
        codeLines.push(line);
      } else if (codeLines.length > 0 && isBlank) {
        codeLines.push(line);
      }
    }
  }

  // Save last action
  if (currentAction) {
    currentAction.code = codeLines.join("\n").trim();
    if (currentAction.code) {
      actions.push(currentAction);
    }
  }

  return actions;
}

/**
 * Validate that actions can be sent to device
 */
export function validateActions(actions: Action[]): void {
  const errors: string[] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];

    if (!action.short) {
      errors.push(`Action ${i + 1}: missing action type (short)`);
    }

    // Note: We don't validate LUA syntax here because naive bracket matching
    // would reject valid code like: print("(") or code with brackets in comments.
    // The device will reject invalid LUA at runtime.
  }

  if (errors.length > 0) {
    throw new ValidationError("Invalid actions", errors);
  }
}

/**
 * Parse device action string format into Action objects
 * Format: --[[@short#name]] code --[[@short2]] code2
 */
// Max script size to prevent ReDoS attacks
const MAX_SCRIPT_SIZE = 100000;

export function parseDeviceFormat(script: string): Action[] {
  if (!script || script.trim() === "") {
    return [];
  }

  // Prevent ReDoS on large malicious input
  if (script.length > MAX_SCRIPT_SIZE) {
    throw new ValidationError("Script too large", [
      `Maximum ${MAX_SCRIPT_SIZE} characters allowed`,
    ]);
  }

  const actions: Action[] = [];

  // Remove formatting
  const actionString = script.replace(/[\n\r]+/g, "").replace(/\s{2,}/g, " ");

  // Pattern: --[[@short#name]] code
  const pattern = /--\[\[@([^\]]*)\]\]\s*(.*?)(?=(--\[\[@|$))/gs;
  const matches = [...actionString.matchAll(pattern)];

  for (const match of matches) {
    const meta = match[1];
    const code = match[2].trim();

    // Split meta into short and optional name
    const parts = meta.split(/#(.*)/, 2);
    const short = parts[0];
    const name = parts[1];

    actions.push({
      short,
      name,
      code,
    });
  }

  return actions;
}

/**
 * Format Action objects to device format
 * Output: --[[@short#name]] code --[[@short2]] code2
 */
export function toDeviceFormat(actions: Action[]): string {
  if (actions.length === 0) {
    return "";
  }

  return actions
    .map((action) => {
      const meta = action.name
        ? `${action.short}#${action.name}`
        : action.short;
      let code: string;
      try {
        code = GridScript.minifyScript(action.code);
      } catch {
        // Lua fragments (e.g. bare if/else/end) can't be parsed; fall back to regex
        code = action.code
          .replace(/[\n\r]+/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim();
      }
      return `--[[@${meta}]] ${code}`;
    })
    .join(" ");
}
