import { SerialConnection } from "../serial/connection.js";
import {
  encodeMessage,
  decodeMessage,
  unwrapScript,
  getMaxConfigLength,
  ClassName,
  type DecodedMessage,
} from "../protocol/codec.js";
import {
  createFetchConfig,
  createSendConfig,
  createStorePage,
} from "../protocol/instructions.js";
import { ResponseWaiter } from "../protocol/waiter.js";
import {
  MODULE_TYPES,
  MODULE_ELEMENTS,
  ELEMENT_EVENTS,
  EventType,
  EVENT_NAMES,
  type ModuleInfo,
  type ModuleConfig,
  type PageConfig,
  type EventConfig,
  type Action,
  type DeviceInfo,
} from "./types.js";
import * as log from "../utils/logger.js";
import { ProtocolError } from "../utils/errors.js";

const DEFAULT_TIMEOUT = 5000;
const NUM_PAGES = 4;

/**
 * High-level interface to a Grid device
 */
export class GridDevice {
  private connection: SerialConnection;
  private modules: Map<string, ModuleInfo> = new Map();
  private pendingWaiters: ResponseWaiter[] = [];
  private messageHandler: ((data: Buffer) => void) | null = null;

  constructor(connection: SerialConnection) {
    this.connection = connection;

    // Set up message handler (store for cleanup)
    this.messageHandler = (data: Buffer) => {
      this.handleMessage(data);
    };
    this.connection.on("message", this.messageHandler);
  }

  get deviceInfo(): DeviceInfo {
    return this.connection.device;
  }

  get isOpen(): boolean {
    return this.connection.isOpen;
  }

  /**
   * Open connection to device
   */
  async open(): Promise<void> {
    await this.connection.open();
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    // Remove message handler
    if (this.messageHandler) {
      this.connection.off("message", this.messageHandler);
      this.messageHandler = null;
    }

    // Cancel any pending waiters (copy array first to avoid race condition)
    const waitersToCancel = [...this.pendingWaiters];
    this.pendingWaiters = [];
    for (const waiter of waitersToCancel) {
      waiter.cancel();
    }

    await this.connection.close();
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: Buffer): void {
    const messages = decodeMessage(data);

    for (const message of messages) {
      log.debug(`Received: ${message.class_name}/${message.class_instr}`);

      // Handle heartbeat - discover modules
      if (message.class_name === ClassName.HEARTBEAT) {
        this.handleHeartbeat(message);
      }

      // Try to match pending waiters
      for (let i = this.pendingWaiters.length - 1; i >= 0; i--) {
        if (this.pendingWaiters[i].tryMatch(message)) {
          this.pendingWaiters.splice(i, 1);
        }
      }
    }
  }

  /**
   * Handle heartbeat message - discover module info
   */
  private handleHeartbeat(message: DecodedMessage): void {
    const sx = message.brc_parameters.SX;
    const sy = message.brc_parameters.SY;

    // Validate required parameters are numbers
    const hwcfg = message.class_parameters.HWCFG;
    if (typeof sx !== "number" || typeof sy !== "number" || typeof hwcfg !== "number") {
      log.debug("Invalid heartbeat parameters, skipping");
      return;
    }

    const key = `${sx},${sy}`;
    const typeId = hwcfg & 0x7f; // Lower 7 bits
    const typeName = MODULE_TYPES[typeId] || `Unknown(${typeId})`;

    // Safely extract firmware version with defaults
    const vmajor = message.class_parameters.VMAJOR;
    const vminor = message.class_parameters.VMINOR;
    const vpatch = message.class_parameters.VPATCH;

    const moduleInfo: ModuleInfo = {
      dx: sx,
      dy: sy,
      type: typeName,
      typeId,
      firmware: {
        major: typeof vmajor === "number" ? vmajor : 0,
        minor: typeof vminor === "number" ? vminor : 0,
        patch: typeof vpatch === "number" ? vpatch : 0,
      },
      elementCount: this.getElementCount(typeName),
    };

    if (!this.modules.has(key)) {
      log.debug(`Discovered module: ${typeName} at (${sx}, ${sy})`);
    }

    this.modules.set(key, moduleInfo);
  }

  /**
   * Get element count for a module type
   */
  private getElementCount(type: string): number {
    const elements = MODULE_ELEMENTS[type];
    if (!elements) return 16; // Default

    return elements.reduce((sum, e) => sum + e.count, 0);
  }

  /**
   * Get element type at index for a module type
   */
  private getElementType(moduleType: string, elementIndex: number): string {
    const elements = MODULE_ELEMENTS[moduleType];
    if (!elements) return "button";

    let index = 0;
    for (const elem of elements) {
      if (elementIndex < index + elem.count) {
        return elem.type;
      }
      index += elem.count;
    }

    return "button";
  }

  /**
   * Get supported events for an element type
   */
  private getSupportedEvents(elementType: string): EventType[] {
    return ELEMENT_EVENTS[elementType] || ELEMENT_EVENTS.button;
  }

  /**
   * Send a message and wait for response
   */
  private async sendAndWait(
    descriptor: ReturnType<typeof createFetchConfig>["descriptor"],
    filter: ReturnType<typeof createFetchConfig>["filter"],
    timeoutMs: number = DEFAULT_TIMEOUT
  ): Promise<DecodedMessage> {
    const waiter = new ResponseWaiter(filter, timeoutMs);
    this.pendingWaiters.push(waiter);

    // Start waiting before sending
    const waitPromise = waiter.start();

    try {
      // Encode and send
      const encoded = encodeMessage(descriptor);
      await this.connection.write(encoded);

      // Wait for response
      return await waitPromise;
    } catch (error) {
      // Clean up waiter on any error (write failure or timeout)
      waiter.cancel();
      throw error;
    } finally {
      // Always remove from pending list
      const index = this.pendingWaiters.indexOf(waiter);
      if (index >= 0) {
        this.pendingWaiters.splice(index, 1);
      }
    }
  }

  /**
   * Wait for modules to be discovered
   */
  async waitForModules(timeoutMs: number = 3000): Promise<ModuleInfo[]> {
    const startTime = Date.now();

    // Wait a bit for heartbeats
    while (Date.now() - startTime < timeoutMs) {
      if (this.modules.size > 0) {
        // Wait a bit more to catch all modules, but respect timeout budget
        const remaining = timeoutMs - (Date.now() - startTime);
        const waitTime = Math.min(500, Math.max(0, remaining));
        if (waitTime > 0) {
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return Array.from(this.modules.values());
  }

  /**
   * Get discovered modules
   */
  getModules(): ModuleInfo[] {
    return Array.from(this.modules.values());
  }

  /**
   * Fetch configuration for a single event
   */
  async fetchEventConfig(
    dx: number,
    dy: number,
    page: number,
    element: number,
    eventType: EventType
  ): Promise<Action[]> {
    const { descriptor, filter } = createFetchConfig(dx, dy, page, element, eventType);

    try {
      const response = await this.sendAndWait(descriptor, filter);

      const actionString = response.class_parameters.ACTIONSTRING;
      if (!actionString) {
        return [];
      }
      if (typeof actionString !== "string") {
        log.warn(`Invalid ACTIONSTRING type from device: ${typeof actionString}`);
        return [];
      }

      return this.parseActions(unwrapScript(actionString));
    } catch (error) {
      log.warn(`Failed to fetch config for page ${page}, element ${element}, event ${eventType}: ${error}`);
      return [];
    }
  }

  /**
   * Parse action string into Action objects
   */
  private parseActions(script: string): Action[] {
    if (!script || script.trim() === "") {
      return [];
    }

    // Prevent ReDoS on large malicious input from device
    if (script.length > 100000) {
      log.warn(`Script too large (${script.length} chars), skipping parse`);
      return [];
    }

    const actions: Action[] = [];

    // Remove formatting
    let actionString = script.replace(/[\n\r]+/g, "").replace(/\s{2,}/g, " ");

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
   * Format actions back to device format
   */
  formatActions(actions: Action[]): string {
    if (actions.length === 0) {
      return "";
    }

    return actions
      .map((action) => {
        const meta = action.name ? `${action.short}#${action.name}` : action.short;
        return `--[[@${meta}]] ${action.code}`;
      })
      .join(" ");
  }

  /**
   * Fetch complete configuration for a module
   */
  async fetchModuleConfig(module: ModuleInfo): Promise<ModuleConfig> {
    const pages: PageConfig[] = [];

    for (let page = 0; page < NUM_PAGES; page++) {
      const events: EventConfig[] = [];

      for (let element = 0; element < module.elementCount; element++) {
        const elementType = this.getElementType(module.type, element);
        const supportedEvents = this.getSupportedEvents(elementType);

        for (const eventType of supportedEvents) {
          log.progress(
            page * module.elementCount * supportedEvents.length +
              element * supportedEvents.length +
              supportedEvents.indexOf(eventType),
            NUM_PAGES * module.elementCount * supportedEvents.length,
            `Fetching page ${page}, element ${element}, ${EVENT_NAMES[eventType]}`
          );

          const actions = await this.fetchEventConfig(
            module.dx,
            module.dy,
            page,
            element,
            eventType
          );

          events.push({
            elementIndex: element,
            eventType,
            actions,
          });
        }
      }

      pages.push({
        pageNumber: page,
        events,
      });
    }

    return {
      module,
      pages,
    };
  }

  /**
   * Send configuration for a single event
   */
  async sendEventConfig(
    dx: number,
    dy: number,
    page: number,
    element: number,
    eventType: EventType,
    actions: Action[]
  ): Promise<void> {
    const actionScript = this.formatActions(actions);

    // Validate byte length (UTF-8 chars can be multi-byte)
    const byteLength = Buffer.byteLength(actionScript, "utf8");
    const maxLength = getMaxConfigLength();
    if (byteLength > maxLength) {
      throw new ProtocolError(
        `Config too large for page ${page}, element ${element}, event ${eventType}: ${byteLength} bytes exceeds max ${maxLength}`
      );
    }

    const { descriptor, filter } = createSendConfig(
      dx,
      dy,
      page,
      element,
      eventType,
      actionScript
    );

    try {
      await this.sendAndWait(descriptor, filter);
    } catch (error) {
      throw new ProtocolError(
        `Failed to send config for page ${page}, element ${element}, event ${eventType}: ${error}`
      );
    }
  }

  /**
   * Send complete configuration for a module
   */
  async sendModuleConfig(config: ModuleConfig): Promise<void> {
    const module = config.module;
    const totalEvents = config.pages.reduce((sum, p) => sum + p.events.length, 0);
    let eventCount = 0;

    for (const page of config.pages) {
      for (const event of page.events) {
        eventCount++;
        log.progress(
          eventCount,
          totalEvents,
          `Sending page ${page.pageNumber}, element ${event.elementIndex}, ${EVENT_NAMES[event.eventType]}`
        );

        await this.sendEventConfig(
          module.dx,
          module.dy,
          page.pageNumber,
          event.elementIndex,
          event.eventType,
          event.actions
        );
      }
    }
  }

  /**
   * Store current configuration to flash
   */
  async storeToFlash(): Promise<void> {
    const { descriptor, filter } = createStorePage();

    log.info("Storing configuration to flash...");

    try {
      await this.sendAndWait(descriptor, filter, 10000); // Longer timeout for flash write
      log.success("Configuration stored to flash");
    } catch (error) {
      throw new ProtocolError(`Failed to store to flash: ${error}`);
    }
  }
}
