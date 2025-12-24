import { SerialConnection } from "../serial/connection.js";
import {
  encodeMessage,
  decodeMessage,
  unwrapScript,
  getMaxConfigLength,
  ClassName,
  type DecodedMessage,
  type MessageDescriptor,
  getModuleTypeFromHwcfg,
  getModuleElementList,
} from "../protocol/codec.js";
import {
  createFetchConfig,
  createSendConfig,
  createStorePage,
  createChangePage,
  createEditorHeartbeat,
  createNVMErase,
} from "../protocol/instructions.js";
import { ResponseWaiter, type ResponseFilter } from "../protocol/waiter.js";
import {
  MODULE_TYPES,
  MODULE_ELEMENTS,
  type EventType,
  type ModuleInfo,
  type ModuleConfig,
  type PageConfig,
  type EventConfig,
  type Action,
  type DeviceInfo,
} from "./types.js";
import { getEventDescriptors, getEventNameForType } from "./events.js";
import * as log from "../utils/logger.js";
import { ProtocolError } from "../utils/errors.js";
import { GridScript } from "../protocol/script.js";
import { parseDeviceFormat } from "../config/parser.js";

const DEFAULT_TIMEOUT = 5000;
const NUM_PAGES = 4;

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * High-level interface to a Grid device
 */
export class GridDevice {
  private connection: SerialConnection;
  private modules: Map<string, ModuleInfo> = new Map();
  private pendingWaiters: ResponseWaiter[] = [];
  private messageHandler: ((data: Buffer) => void) | null = null;
  private pageChangeDisabled = false;
  private editorHeartbeatTimer: NodeJS.Timeout | null = null;
  private closing = false;

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
    this.startEditorHeartbeat();
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    // Set closing flag to prevent handleMessage from processing new messages
    this.closing = true;

    this.stopEditorHeartbeat();

    // Remove message handler first to prevent new messages from arriving
    if (this.messageHandler) {
      this.connection.off("message", this.messageHandler);
      this.messageHandler = null;
    }

    // Now cancel any pending waiters - safe because no new messages will arrive
    const waitersToCancel = [...this.pendingWaiters];
    this.pendingWaiters = [];
    for (const waiter of waitersToCancel) {
      waiter.cancel();
    }

    await this.connection.close();
  }

  private startEditorHeartbeat(
    type: number = 255,
    intervalMs: number = 300,
  ): void {
    if (this.editorHeartbeatTimer) {
      clearInterval(this.editorHeartbeatTimer);
    }

    const sendHeartbeat = async () => {
      const descriptor = createEditorHeartbeat(type);
      try {
        await this.connection.write(encodeMessage(descriptor));
      } catch (error) {
        log.debug(
          `Failed to send editor heartbeat: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    void sendHeartbeat();
    this.editorHeartbeatTimer = setInterval(() => {
      void sendHeartbeat();
    }, intervalMs);
  }

  private stopEditorHeartbeat(): void {
    if (this.editorHeartbeatTimer) {
      clearInterval(this.editorHeartbeatTimer);
      this.editorHeartbeatTimer = null;
    }
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: Buffer): void {
    // Don't process messages if we're closing
    if (this.closing) {
      return;
    }

    const messages = decodeMessage(data);

    for (const message of messages) {
      log.debug(`Received: ${message.class_name}/${message.class_instr}`);

      if (
        message.class_name === ClassName.CONFIG &&
        message.class_instr === "REPORT"
      ) {
        log.debug(
          `CONFIG REPORT brc=${JSON.stringify(message.brc_parameters)} params=${JSON.stringify(
            message.class_parameters,
          )}`,
        );
      }
      if (
        message.class_name === ClassName.CONFIG &&
        message.class_instr === "ACKNOWLEDGE"
      ) {
        log.debug(
          `CONFIG ACK brc=${JSON.stringify(message.brc_parameters)} params=${JSON.stringify(
            message.class_parameters,
          )}`,
        );
      }
      if (
        message.class_name === ClassName.PAGEACTIVE &&
        message.class_instr === "REPORT"
      ) {
        log.debug(
          `PAGEACTIVE REPORT brc=${JSON.stringify(message.brc_parameters)} params=${JSON.stringify(
            message.class_parameters,
          )}`,
        );
      }
      if (message.class_name === "DEBUGTEXT") {
        const text = message.class_parameters.TEXT;
        if (typeof text === "string" && text.length > 0) {
          log.debug(`DEBUGTEXT: ${text}`);
          if (text.toLowerCase().includes("page change is disabled")) {
            this.pageChangeDisabled = true;
            log.warn(
              "Device reports page change is disabled; will store before retrying.",
            );
          }
        } else {
          log.debug(
            `DEBUGTEXT params=${JSON.stringify(message.class_parameters)}`,
          );
        }
      }

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
    const sx = parseNumber(message.brc_parameters.SX);
    const sy = parseNumber(message.brc_parameters.SY);

    // Validate required parameters are numbers
    const hwcfg = parseNumber(message.class_parameters.HWCFG);
    if (sx === null || sy === null || hwcfg === null) {
      log.debug("Invalid heartbeat parameters, skipping");
      return;
    }

    const key = `${sx},${sy}`;
    const typeId = hwcfg;
    const typeName =
      getModuleTypeFromHwcfg(hwcfg) ||
      MODULE_TYPES[hwcfg & 0x7f] ||
      `Unknown(${hwcfg})`;

    // Safely extract firmware version with defaults
    const vmajor = parseNumber(message.class_parameters.VMAJOR);
    const vminor = parseNumber(message.class_parameters.VMINOR);
    const vpatch = parseNumber(message.class_parameters.VPATCH);

    const moduleInfo: ModuleInfo = {
      dx: sx,
      dy: sy,
      type: typeName,
      typeId,
      firmware: {
        major: vmajor ?? 0,
        minor: vminor ?? 0,
        patch: vpatch ?? 0,
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
    const protocolElements = getModuleElementList(type);
    if (protocolElements) {
      const indices = this.getElementIndicesFromList(protocolElements);
      if (indices.length > 0) {
        return indices.length;
      }
    }

    const elements = MODULE_ELEMENTS[type];
    if (!elements) return 16; // Default

    return elements.reduce((sum, e) => sum + e.count, 0);
  }

  private getElementIndices(type: string): number[] {
    const protocolElements = getModuleElementList(type);
    if (protocolElements) {
      const indices = this.getElementIndicesFromList(protocolElements);
      if (indices.length > 0) {
        return indices;
      }
    }

    const elements = MODULE_ELEMENTS[type];
    if (!elements) {
      return Array.from({ length: 16 }, (_, i) => i);
    }

    const total = elements.reduce((sum, e) => sum + e.count, 0);
    return Array.from({ length: total }, (_, i) => i);
  }

  private getElementIndicesFromList(
    protocolElements: Array<string | undefined>,
  ): number[] {
    const indices: number[] = [];
    for (let i = 0; i < protocolElements.length; i++) {
      const entry = protocolElements[i];
      if (typeof entry === "string" && entry.length > 0) {
        indices.push(i);
      }
    }
    return indices;
  }

  /**
   * Get element type at index for a module type
   */
  private getElementType(moduleType: string, elementIndex: number): string {
    const protocolElements = getModuleElementList(moduleType);
    if (
      protocolElements &&
      elementIndex >= 0 &&
      elementIndex < protocolElements.length
    ) {
      const elementType = protocolElements[elementIndex];
      if (typeof elementType === "string" && elementType.length > 0) {
        return elementType;
      }
    }

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
    return getEventDescriptors(elementType).map((event) => event.value);
  }

  /**
   * Send a message and wait for response
   */
  private async sendAndWait(
    descriptor: MessageDescriptor,
    filter: ResponseFilter,
    timeoutMs: number = DEFAULT_TIMEOUT,
    retries: number = 0,
    retryDelayMs: number = 100,
  ): Promise<DecodedMessage> {
    let attempt = 0;
    while (true) {
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
        if (
          error instanceof Error &&
          error.name === "TimeoutError" &&
          attempt < retries
        ) {
          attempt++;
          log.debug(
            `Timeout waiting for response; retrying (${attempt}/${retries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        throw error;
      } finally {
        // Always remove from pending list
        const index = this.pendingWaiters.indexOf(waiter);
        if (index >= 0) {
          this.pendingWaiters.splice(index, 1);
        }
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
   * Result of fetching event config - distinguishes empty config from fetch failure
   */
  private fetchEventConfigResult(
    actions: Action[],
    failed: boolean = false,
  ): { actions: Action[]; failed: boolean } {
    return { actions, failed };
  }

  /**
   * Fetch configuration for a single event
   * Returns actions and a failed flag to distinguish empty config from fetch failure
   */
  async fetchEventConfig(
    dx: number,
    dy: number,
    page: number,
    element: number,
    eventType: EventType,
  ): Promise<{ actions: Action[]; failed: boolean }> {
    const { descriptor, filter } = createFetchConfig(
      dx,
      dy,
      page,
      element,
      eventType,
    );

    try {
      const response = await this.sendAndWait(
        descriptor,
        filter,
        DEFAULT_TIMEOUT,
        1,
      );

      const actionString = response.class_parameters.ACTIONSTRING;
      if (!actionString) {
        return this.fetchEventConfigResult([]);
      }
      if (typeof actionString !== "string") {
        log.warn(
          `Invalid ACTIONSTRING type from device: ${typeof actionString}`,
        );
        return this.fetchEventConfigResult([], true);
      }

      return this.fetchEventConfigResult(
        parseDeviceFormat(unwrapScript(actionString)),
      );
    } catch (error) {
      log.warn(
        `Failed to fetch config for page ${page}, element ${element}, event ${eventType}: ${error}`,
      );
      return this.fetchEventConfigResult([], true);
    }
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
        const meta = action.name
          ? `${action.short}#${action.name}`
          : action.short;
        // Shortify the code, then compress to single line (device requires single-line format)
        const shortCode = GridScript.shortify(action.code)
          .replace(/[\n\r]+/g, " ")
          .replace(/\s{2,}/g, " ")
          .trim();
        return `--[[@${meta}]] ${shortCode}`;
      })
      .join(" ");
  }

  /**
   * Fetch complete configuration for a module
   * Throws ProtocolError if too many fetch failures occur
   */
  async fetchModuleConfig(
    module: ModuleInfo,
    options: {
      includePages?: Set<number> | null;
      excludePages?: Set<number> | null;
    } = {},
  ): Promise<ModuleConfig> {
    const pages: PageConfig[] = [];
    const elementIndices = this.getElementIndices(module.type);
    const pageNumbers = Array.from({ length: NUM_PAGES }, (_, i) => i).filter(
      (page) => {
        if (options.includePages) return options.includePages.has(page);
        if (options.excludePages) return !options.excludePages.has(page);
        return true;
      },
    );
    const eventsPerPage = elementIndices.reduce((sum, elementIndex) => {
      const elementType = this.getElementType(module.type, elementIndex);
      return sum + this.getSupportedEvents(elementType).length;
    }, 0);
    const totalEvents = eventsPerPage * pageNumbers.length;
    let progressIndex = 0;
    let failedCount = 0;
    const maxFailures = Math.max(5, Math.floor(totalEvents * 0.1)); // Allow up to 10% failures or at least 5

    for (const page of pageNumbers) {
      const events: EventConfig[] = [];

      for (const element of elementIndices) {
        const elementType = this.getElementType(module.type, element);
        const supportedEvents = this.getSupportedEvents(elementType);

        for (const eventType of supportedEvents) {
          log.progress(
            progressIndex + 1,
            totalEvents,
            `Fetching page ${page}, element ${element}, ${getEventNameForType(elementType, eventType)}`,
          );
          progressIndex++;

          const result = await this.fetchEventConfig(
            module.dx,
            module.dy,
            page,
            element,
            eventType,
          );

          if (result.failed) {
            failedCount++;
            if (failedCount > maxFailures) {
              throw new ProtocolError(
                `Too many fetch failures (${failedCount}/${totalEvents}). ` +
                  `Device communication may be unstable.`,
              );
            }
          }

          events.push({
            elementIndex: element,
            eventType,
            actions: result.actions,
          });
        }
      }

      pages.push({
        pageNumber: page,
        events,
      });
    }

    if (failedCount > 0) {
      log.warn(
        `${failedCount} event(s) failed to fetch and were returned as empty.`,
      );
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
    actions: Action[],
  ): Promise<void> {
    const actionScript = this.formatActions(actions);

    // Validate byte length (UTF-8 chars can be multi-byte)
    const byteLength = Buffer.byteLength(actionScript, "utf8");
    const maxLength = getMaxConfigLength();
    if (byteLength > maxLength) {
      throw new ProtocolError(
        `Config too large for page ${page}, element ${element}, event ${eventType}: ${byteLength} bytes exceeds max ${maxLength}`,
      );
    }

    const { descriptor, filter } = createSendConfig(
      dx,
      dy,
      page,
      element,
      eventType,
      actionScript,
    );

    try {
      await this.sendAndWait(descriptor, filter, 10000, 2);
    } catch (error) {
      throw new ProtocolError(
        `Failed to send config for page ${page}, element ${element}, event ${eventType}: ${error}`,
      );
    }
  }

  /**
   * Send complete configuration for a module
   * @param config The module configuration to send
   * @param targetModule Optional device module to send to (for type-based matching)
   */
  async sendModuleConfig(
    config: ModuleConfig,
    targetModule?: ModuleInfo,
  ): Promise<void> {
    // Use target module position if provided, otherwise use config position
    const module = targetModule ?? config.module;
    let activePage: number | null = null;
    const totalEvents = config.pages.reduce(
      (sum, p) => sum + p.events.length,
      0,
    );
    let eventCount = 0;

    for (const page of config.pages) {
      if (activePage !== page.pageNumber) {
        const changed = await this.changePage(page.pageNumber, module);
        if (!changed && page.pageNumber > 0) {
          throw new ProtocolError(
            `Failed to switch to page ${page.pageNumber} before sending configs.`,
          );
        }
        activePage = page.pageNumber;
      }
      for (const event of page.events) {
        eventCount++;
        log.progress(
          eventCount,
          totalEvents,
          `Sending page ${page.pageNumber}, element ${event.elementIndex}, ${getEventNameForType(
            this.getElementType(module.type, event.elementIndex),
            event.eventType,
          )}`,
        );

        await this.sendEventConfig(
          module.dx,
          module.dy,
          page.pageNumber,
          event.elementIndex,
          event.eventType,
          event.actions,
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
  }

  private async changePage(
    pageNumber: number,
    module?: ModuleInfo,
  ): Promise<boolean> {
    if (this.pageChangeDisabled && pageNumber > 0) {
      log.warn(
        "Page change disabled; storing configuration to allow page switch.",
      );
      try {
        await this.storeToFlash();
        // Only reset the flag if store succeeded
        this.pageChangeDisabled = false;
      } catch (error) {
        log.warn(`Failed to store before page change: ${error}`);
        // Don't reset pageChangeDisabled - will retry on next page change attempt
      }
    }

    const attempts: Array<{ dx: number; dy: number; label: string }> = [
      { dx: -127, dy: -127, label: "global" },
    ];
    if (module) {
      attempts.push({ dx: module.dx, dy: module.dy, label: "module" });
    }

    // Try twice - suppress warning on first round, only warn if second round also fails
    for (let round = 0; round < 2; round++) {
      for (const attempt of attempts) {
        const { descriptor } = createChangePage(
          pageNumber,
          attempt.dx,
          attempt.dy,
        );
        const filter: ResponseFilter = {
          class_name: ClassName.PAGEACTIVE,
          class_instr: "REPORT",
          class_parameters: {
            PAGENUMBER: pageNumber,
          },
        };

        log.debug(
          `Requesting page ${pageNumber} (${attempt.label} dx=${attempt.dx}, dy=${attempt.dy})`,
        );

        try {
          await this.sendAndWait(descriptor, filter, 1500, 0);
          return true;
        } catch (error) {
          log.debug(
            `Page ${pageNumber} change (${attempt.label}) not confirmed: ${error}`,
          );
        }
      }
    }

    log.warn(`Failed to confirm page change to ${pageNumber}.`);
    return false;
  }

  /**
   * Store current configuration to flash
   */
  async storeToFlash(): Promise<void> {
    const { descriptor, filter } = createStorePage();

    log.info("Storing configuration to flash...");

    try {
      await this.sendAndWait(descriptor, filter, 10000, 1); // Longer timeout for flash write
      log.success("Configuration stored to flash");
    } catch (error) {
      throw new ProtocolError(`Failed to store to flash: ${error}`);
    }
  }

  /**
   * Erase NVM (factory reset) on the device
   */
  async eraseNvm(): Promise<void> {
    const { descriptor, filter } = createNVMErase();

    log.info("Erasing device NVM...");

    try {
      await this.sendAndWait(descriptor, filter, 15000, 0);
      log.success("Device NVM erased");
    } catch (error) {
      throw new ProtocolError(`Failed to erase NVM: ${error}`);
    }
  }
}
