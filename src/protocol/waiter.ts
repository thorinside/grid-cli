import { TimeoutError } from "../utils/errors.js";
import type { DecodedMessage } from "./codec.js";

export interface ResponseFilter {
  brc_parameters?: {
    SX?: number;
    SY?: number;
  };
  class_name?: string;
  class_instr?: string;
  class_parameters?: Record<string, unknown>;
}

/**
 * Matches a decoded message against a filter
 */
export function matchesFilter(
  message: DecodedMessage,
  filter: ResponseFilter,
): boolean {
  const valuesEqual = (left: unknown, right: unknown): boolean => {
    if (left === right) return true;
    if (typeof left === "number" && typeof right === "string") {
      const parsed = Number(right);
      return Number.isFinite(parsed) && left === parsed;
    }
    if (typeof left === "string" && typeof right === "number") {
      const parsed = Number(left);
      return Number.isFinite(parsed) && parsed === right;
    }
    return false;
  };

  // Check BRC parameters
  if (filter.brc_parameters) {
    for (const [key, value] of Object.entries(filter.brc_parameters)) {
      const actual = (message.brc_parameters as Record<string, unknown>)[key];
      if (!valuesEqual(actual, value)) {
        return false;
      }
    }
  }

  // Check class name
  if (filter.class_name && message.class_name !== filter.class_name) {
    return false;
  }

  // Check class instruction
  if (filter.class_instr && message.class_instr !== filter.class_instr) {
    return false;
  }

  // Check class parameters
  if (filter.class_parameters) {
    for (const [key, value] of Object.entries(filter.class_parameters)) {
      if (value !== null) {
        const actual = message.class_parameters[key];
        if (!valuesEqual(actual, value)) {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Waits for a response matching a filter with timeout
 */
export class ResponseWaiter {
  private resolve!: (message: DecodedMessage) => void;
  private reject!: (error: Error) => void;
  private timeoutId: NodeJS.Timeout | null = null;
  private promise: Promise<DecodedMessage>;
  private settled = false;

  constructor(
    private filter: ResponseFilter,
    private timeoutMs: number = 5000,
  ) {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  /**
   * Start waiting for response
   */
  start(): Promise<DecodedMessage> {
    this.timeoutId = setTimeout(() => {
      if (this.settled) return;
      this.settled = true;
      this.reject(
        new TimeoutError(`Timeout waiting for response (${this.timeoutMs}ms)`),
      );
    }, this.timeoutMs);

    return this.promise;
  }

  /**
   * Check if a message matches and resolve if so
   * Returns true if matched and resolved
   */
  tryMatch(message: DecodedMessage): boolean {
    if (this.settled) return false;
    if (matchesFilter(message, this.filter)) {
      this.settled = true;
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
      this.resolve(message);
      return true;
    }
    return false;
  }

  /**
   * Cancel waiting
   */
  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.reject(new Error("Cancelled"));
  }
}
