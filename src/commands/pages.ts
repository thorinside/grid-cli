import { GridError } from "../utils/errors.js";

/**
 * Parse a comma-separated list of page numbers or ranges (e.g., "0,2-3")
 */
export function parsePageList(input: string): Set<number> {
  const result = new Set<number>();
  const parts = input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (part.includes("-")) {
      const [startRaw, endRaw] = part.split("-", 2);
      const start = Number(startRaw);
      const end = Number(endRaw);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        throw new GridError(`Invalid page range: ${part}`);
      }
      for (let i = start; i <= end; i++) {
        result.add(i);
      }
    } else {
      const value = Number(part);
      if (!Number.isInteger(value)) {
        throw new GridError(`Invalid page number: ${part}`);
      }
      result.add(value);
    }
  }

  return result;
}
