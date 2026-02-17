import { SerialPort } from "serialport";
import { EventEmitter } from "events";
import { MessageFramer, frameMessage } from "./framer.js";
import { DeviceInfo } from "../device/types.js";
import { ConnectionError } from "../utils/errors.js";
import * as log from "../utils/logger.js";

const BAUD_RATE = 2000000;

export interface SerialConnectionEvents {
  message: (data: Buffer) => void;
  error: (error: Error) => void;
  close: () => void;
}

interface PendingWaiter {
  handler: (data: Buffer) => void;
  timeout: ReturnType<typeof setTimeout>;
  reject: (err: Error) => void;
}

export class SerialConnection extends EventEmitter {
  private port: SerialPort | null = null;
  private framer: MessageFramer | null = null;
  private _isOpen = false;
  private portErrorHandler: ((err: Error) => void) | null = null;
  private portCloseHandler: (() => void) | null = null;
  private framerDataHandler: ((message: Buffer) => void) | null = null;
  private pendingWaiters: PendingWaiter[] = [];

  constructor(private deviceInfo: DeviceInfo) {
    super();
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  get device(): DeviceInfo {
    return this.deviceInfo;
  }

  async open(): Promise<void> {
    if (this._isOpen) {
      return;
    }

    log.debug(`Opening connection to ${this.deviceInfo.path}`);

    return new Promise((resolve, reject) => {
      this.port = new SerialPort(
        {
          path: this.deviceInfo.path,
          baudRate: BAUD_RATE,
          autoOpen: false,
        },
        (err) => {
          if (err) {
            reject(
              new ConnectionError(`Failed to create port: ${err.message}`),
            );
          }
        },
      );

      // Store handlers for cleanup
      this.portErrorHandler = (err) => {
        log.error(`Serial error: ${err.message}`);
        this.emit("error", err);
      };
      this.portCloseHandler = () => {
        log.debug("Serial port closed");
        this._isOpen = false;
        this.emit("close");
      };

      this.port.on("error", this.portErrorHandler);
      this.port.on("close", this.portCloseHandler);

      // Set up message framing
      this.framer = new MessageFramer();
      this.port.pipe(this.framer);

      this.framerDataHandler = (message: Buffer) => {
        log.debug(`Received message: ${message.length} bytes`);
        this.emit("message", message);
      };
      this.framer.on("data", this.framerDataHandler);

      this.port.open((err) => {
        if (err) {
          // Clean up resources on open failure
          if (this.framer && this.framerDataHandler) {
            this.framer.off("data", this.framerDataHandler);
          }
          if (this.port) {
            if (this.framer) {
              this.port.unpipe(this.framer);
            }
            if (this.portErrorHandler) {
              this.port.off("error", this.portErrorHandler);
            }
            if (this.portCloseHandler) {
              this.port.off("close", this.portCloseHandler);
            }
          }
          this.port = null;
          this.framer = null;
          this.portErrorHandler = null;
          this.portCloseHandler = null;
          this.framerDataHandler = null;
          reject(new ConnectionError(`Failed to open port: ${err.message}`));
          return;
        }

        this._isOpen = true;
        log.debug("Serial port opened");
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this._isOpen || !this.port) {
      return;
    }

    log.debug("Closing serial connection");

    // Cancel any pending waitForMessage calls
    const waitersToCancel = [...this.pendingWaiters];
    this.pendingWaiters = [];
    for (const waiter of waitersToCancel) {
      clearTimeout(waiter.timeout);
      this.off("message", waiter.handler);
      waiter.reject(new ConnectionError("Connection closed"));
    }

    // Remove event listeners and unpipe before closing
    if (this.framer && this.framerDataHandler) {
      this.framer.off("data", this.framerDataHandler);
    }
    if (this.port) {
      // Unpipe to prevent memory leak
      if (this.framer) {
        this.port.unpipe(this.framer);
      }
      if (this.portErrorHandler) {
        this.port.off("error", this.portErrorHandler);
      }
      if (this.portCloseHandler) {
        this.port.off("close", this.portCloseHandler);
      }
    }

    return new Promise((resolve, reject) => {
      this.port!.close((err) => {
        if (err) {
          reject(new ConnectionError(`Failed to close port: ${err.message}`));
          return;
        }
        this._isOpen = false;
        this.port = null;
        this.framer = null;
        this.portErrorHandler = null;
        this.portCloseHandler = null;
        this.framerDataHandler = null;
        resolve();
      });
    });
  }

  async write(data: Buffer): Promise<void> {
    if (!this._isOpen || !this.port) {
      throw new ConnectionError("Connection not open");
    }

    const framedData = frameMessage(data);
    log.debug(`Writing ${framedData.length} bytes`);

    return new Promise((resolve, reject) => {
      this.port!.write(framedData, (err) => {
        if (err) {
          reject(new ConnectionError(`Write failed: ${err.message}`));
          return;
        }
        this.port!.drain((drainErr) => {
          if (drainErr) {
            reject(new ConnectionError(`Drain failed: ${drainErr.message}`));
            return;
          }
          resolve();
        });
      });
    });
  }

  /**
   * Wait for a message matching a predicate
   */
  async waitForMessage(
    predicate: (data: Buffer) => boolean,
    timeoutMs: number = 5000,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const handler = (data: Buffer) => {
        if (settled) return;
        if (predicate(data)) {
          settled = true;
          cleanup();
          resolve(data);
        }
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new ConnectionError(`Timeout waiting for message (${timeoutMs}ms)`),
        );
      }, timeoutMs);

      const waiter: PendingWaiter = { handler, timeout, reject };

      const cleanup = () => {
        const index = this.pendingWaiters.indexOf(waiter);
        if (index >= 0) {
          this.pendingWaiters.splice(index, 1);
        }
        clearTimeout(waiter.timeout);
        this.off("message", waiter.handler);
      };

      this.pendingWaiters.push(waiter);
      this.on("message", handler);
    });
  }
}
