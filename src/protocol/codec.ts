import * as log from "../utils/logger.js";
import type { ElementType, ModuleType } from "@intechstudio/grid-protocol";
import { initLuaFormatter } from "../protocol/script.js";

// Lazy-loaded grid protocol module (to suppress debug output)
let gridModule: typeof import("@intechstudio/grid-protocol") | null = null;

async function getGrid() {
  if (!gridModule) {
    // Suppress debug output during import
    const originalLog = console.log;
    try {
      console.log = () => {};
      gridModule = await import("@intechstudio/grid-protocol");
    } finally {
      console.log = originalLog;
    }
  }
  return gridModule.grid;
}

// Synchronous access after initialization
let grid: (typeof import("@intechstudio/grid-protocol"))["grid"] | undefined;

/**
 * Initialize the protocol module (must be called before using other functions)
 */
export async function initProtocol(): Promise<void> {
  grid = await getGrid();
  await initLuaFormatter();
}

/**
 * Get initialized grid module (throws if not initialized)
 */
function getInitializedGrid(): NonNullable<typeof grid> {
  if (!grid) {
    throw new Error("Protocol not initialized. Call initProtocol() first.");
  }
  return grid;
}

function getGridIfInitialized(): NonNullable<typeof grid> | undefined {
  return grid ?? undefined;
}

/**
 * Instruction class names
 */
export enum ClassName {
  HEARTBEAT = "HEARTBEAT",
  IMMEDIATE = "IMMEDIATE",
  CONFIG = "CONFIG",
  PAGEACTIVE = "PAGEACTIVE",
  PAGECOUNT = "PAGECOUNT",
  PAGESTORE = "PAGESTORE",
  NVMERASE = "NVMERASE",
  NVMDEFRAG = "NVMDEFRAG",
  PAGEDISCARD = "PAGEDISCARD",
  PAGECLEAR = "PAGECLEAR",
  LEDPREVIEW = "LEDPREVIEW",
  EVENTPREVIEW = "EVENTPREVIEW",
  NAMEPREVIEW = "NAMEPREVIEW",
}

/**
 * Instruction types
 */
export enum InstructionType {
  EXECUTE = "EXECUTE",
  FETCH = "FETCH",
  REPORT = "REPORT",
  ACKNOWLEDGE = "ACKNOWLEDGE",
}

/**
 * Message descriptor for encoding
 */
export interface MessageDescriptor {
  brc_parameters: {
    DX: number;
    DY: number;
    ROT?: number;
  };
  class_name: ClassName;
  class_instr: InstructionType;
  class_parameters: Record<string, unknown>;
}

/**
 * Decoded message from device
 */
export interface DecodedMessage {
  brc_parameters: {
    SX: number;
    SY: number;
    ROT?: number;
  };
  class_name: string;
  class_instr: string;
  class_parameters: Record<string, unknown>;
}

/**
 * Encode a message descriptor to bytes for transmission
 */
export function encodeMessage(descriptor: MessageDescriptor): Buffer {
  const g = getInitializedGrid();
  const result = g.encode_packet(descriptor) as
    | { id: string; serial: number[] }
    | undefined;
  if (!result) {
    throw new Error("Failed to encode packet");
  }
  log.debug(`Encoded packet ID: ${result.id}, length: ${result.serial.length}`);
  return Buffer.from(result.serial);
}

/**
 * Decode raw bytes from device into message objects
 */
export function decodeMessage(data: Buffer): DecodedMessage[] {
  const g = getInitializedGrid();
  const byteArray = Array.from(data);

  // Decode the packet frame
  const classArray = g.decode_packet_frame(byteArray);

  if (!Array.isArray(classArray)) {
    log.debug("Failed to decode packet frame");
    return [];
  }

  // Decode the packet classes
  g.decode_packet_classes(classArray);

  return classArray as DecodedMessage[];
}

/**
 * Get grid protocol version info
 */
export function getProtocolVersion(): {
  major: number;
  minor: number;
  patch: number;
} {
  const g = getInitializedGrid();
  const version = g.getProperty("VERSION");
  return {
    major: version.MAJOR,
    minor: version.MINOR,
    patch: version.PATCH,
  };
}

/**
 * Get max config length
 */
export function getMaxConfigLength(): number {
  const g = getInitializedGrid();
  return g.getProperty("CONFIG_LENGTH");
}

export interface ElementEventInfo {
  name: string;
  value: number;
  key?: string;
  defaultConfig?: string;
}

export function getModuleTypeFromHwcfg(hwcfg: number): string | undefined {
  const g = getGridIfInitialized();
  if (!g) return undefined;
  const type = g.module_type_from_hwcfg(hwcfg);
  return typeof type === "string" && type.length > 0 ? type : undefined;
}

export function getModuleElementList(
  moduleType: string,
): Array<string | undefined> | undefined {
  const g = getGridIfInitialized();
  if (!g) return undefined;
  const list = g.get_module_element_list(moduleType as ModuleType);
  if (!Array.isArray(list)) return undefined;
  return list as Array<string | undefined>;
}

export function getElementEvents(
  elementType: string,
): ElementEventInfo[] | undefined {
  const g = getGridIfInitialized();
  if (!g) return undefined;
  const events = g.get_element_events(elementType as ElementType);
  if (!Array.isArray(events)) return undefined;
  const result: ElementEventInfo[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const value = Number((event as { value?: unknown }).value);
    if (!Number.isFinite(value)) continue;
    const name = String((event as { desc?: unknown }).desc ?? "");
    const key = (event as { key?: unknown }).key;
    const defaultConfig = (event as { defaultConfig?: unknown }).defaultConfig;
    result.push({
      name,
      value,
      key: typeof key === "string" ? key : undefined,
      defaultConfig:
        typeof defaultConfig === "string" ? defaultConfig : undefined,
    });
  }
  return result.length > 0 ? result : undefined;
}

/**
 * Script delimiters
 */
export const SCRIPT_START = "<?lua ";
export const SCRIPT_END = " ?>";

/**
 * Wrap script in delimiters
 */
export function wrapScript(script: string): string {
  return SCRIPT_START + script + SCRIPT_END;
}

/**
 * Unwrap script from delimiters
 */
export function unwrapScript(wrapped: string): string {
  if (wrapped.startsWith(SCRIPT_START) && wrapped.endsWith(SCRIPT_END)) {
    return wrapped.slice(SCRIPT_START.length, -SCRIPT_END.length);
  }
  return wrapped;
}
