import {
  ClassName,
  InstructionType,
  MessageDescriptor,
  getProtocolVersion,
  wrapScript,
} from "./codec.js";
import type { ResponseFilter } from "./waiter.js";
import { ProtocolError } from "../utils/errors.js";

/**
 * Validate protocol parameters are within valid bounds
 */
function validateBounds(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProtocolError(`Invalid ${name}: ${value} (must be integer ${min} to ${max})`);
  }
}

/**
 * Create a fetch config instruction
 */
export function createFetchConfig(
  dx: number,
  dy: number,
  page: number,
  element: number,
  eventType: number
): { descriptor: MessageDescriptor; filter: ResponseFilter } {
  // Validate parameters
  validateBounds("dx", dx, -127, 127);
  validateBounds("dy", dy, -127, 127);
  validateBounds("page", page, 0, 255);
  validateBounds("element", element, 0, 255);
  validateBounds("eventType", eventType, 0, 255);

  const version = getProtocolVersion();

  const descriptor: MessageDescriptor = {
    brc_parameters: { DX: dx, DY: dy },
    class_name: ClassName.CONFIG,
    class_instr: InstructionType.FETCH,
    class_parameters: {
      VERSIONMAJOR: version.major,
      VERSIONMINOR: version.minor,
      VERSIONPATCH: version.patch,
      PAGENUMBER: page,
      ELEMENTNUMBER: element,
      EVENTTYPE: eventType,
      ACTIONLENGTH: 0,
    },
  };

  const filter: ResponseFilter = {
    brc_parameters: { SX: dx, SY: dy },
    class_name: ClassName.CONFIG,
    class_instr: InstructionType.REPORT,
    class_parameters: {
      PAGENUMBER: page,
      ELEMENTNUMBER: element,
      EVENTTYPE: eventType,
    },
  };

  return { descriptor, filter };
}

/**
 * Create a send config instruction
 */
export function createSendConfig(
  dx: number,
  dy: number,
  page: number,
  element: number,
  eventType: number,
  actionScript: string
): { descriptor: MessageDescriptor; filter: ResponseFilter } {
  // Validate parameters
  validateBounds("dx", dx, -127, 127);
  validateBounds("dy", dy, -127, 127);
  validateBounds("page", page, 0, 255);
  validateBounds("element", element, 0, 255);
  validateBounds("eventType", eventType, 0, 255);

  const version = getProtocolVersion();
  const actionString = wrapScript(actionScript);

  const descriptor: MessageDescriptor = {
    brc_parameters: { DX: dx, DY: dy },
    class_name: ClassName.CONFIG,
    class_instr: InstructionType.EXECUTE,
    class_parameters: {
      VERSIONMAJOR: version.major,
      VERSIONMINOR: version.minor,
      VERSIONPATCH: version.patch,
      PAGENUMBER: page,
      ELEMENTNUMBER: element,
      EVENTTYPE: eventType,
      ACTIONLENGTH: actionString.length,
      ACTIONSTRING: actionString,
    },
  };

  const filter: ResponseFilter = {
    brc_parameters: { SX: dx, SY: dy },
    class_name: ClassName.CONFIG,
    class_instr: InstructionType.ACKNOWLEDGE,
  };

  return { descriptor, filter };
}

/**
 * Create a store page instruction (persist to flash)
 */
export function createStorePage(): { descriptor: MessageDescriptor; filter: ResponseFilter } {
  const descriptor: MessageDescriptor = {
    brc_parameters: { DX: -127, DY: -127 },
    class_name: ClassName.PAGESTORE,
    class_instr: InstructionType.EXECUTE,
    class_parameters: {},
  };

  const filter: ResponseFilter = {
    class_name: ClassName.PAGESTORE,
    class_instr: InstructionType.ACKNOWLEDGE,
    class_parameters: {
      LASTHEADER: null,
    },
  };

  return { descriptor, filter };
}

/**
 * Create a change page instruction
 */
export function createChangePage(page: number): { descriptor: MessageDescriptor } {
  const descriptor: MessageDescriptor = {
    brc_parameters: { DX: -127, DY: -127 },
    class_name: ClassName.PAGEACTIVE,
    class_instr: InstructionType.EXECUTE,
    class_parameters: {
      PAGENUMBER: page,
    },
  };

  return { descriptor };
}

/**
 * Create a fetch page count instruction
 */
export function createFetchPageCount(
  dx: number,
  dy: number
): { descriptor: MessageDescriptor; filter: ResponseFilter } {
  const descriptor: MessageDescriptor = {
    brc_parameters: { DX: dx, DY: dy },
    class_name: ClassName.PAGECOUNT,
    class_instr: InstructionType.FETCH,
    class_parameters: {},
  };

  const filter: ResponseFilter = {
    class_name: ClassName.PAGECOUNT,
    class_instr: InstructionType.REPORT,
  };

  return { descriptor, filter };
}

/**
 * Create an NVM erase instruction (factory reset)
 */
export function createNVMErase(): { descriptor: MessageDescriptor; filter: ResponseFilter } {
  const descriptor: MessageDescriptor = {
    brc_parameters: { DX: -127, DY: -127 },
    class_name: ClassName.NVMERASE,
    class_instr: InstructionType.EXECUTE,
    class_parameters: {},
  };

  const filter: ResponseFilter = {
    class_name: ClassName.NVMERASE,
    class_instr: InstructionType.ACKNOWLEDGE,
    class_parameters: {
      LASTHEADER: null,
    },
  };

  return { descriptor, filter };
}

/**
 * Create a discard page instruction (discard unsaved changes)
 */
export function createDiscardPage(): { descriptor: MessageDescriptor; filter: ResponseFilter } {
  const descriptor: MessageDescriptor = {
    brc_parameters: { DX: -127, DY: -127 },
    class_name: ClassName.PAGEDISCARD,
    class_instr: InstructionType.EXECUTE,
    class_parameters: {},
  };

  const filter: ResponseFilter = {
    class_name: ClassName.PAGEDISCARD,
    class_instr: InstructionType.ACKNOWLEDGE,
    class_parameters: {
      LASTHEADER: null,
    },
  };

  return { descriptor, filter };
}

/**
 * Create a clear page instruction
 */
export function createClearPage(): { descriptor: MessageDescriptor; filter: ResponseFilter } {
  const descriptor: MessageDescriptor = {
    brc_parameters: { DX: -127, DY: -127 },
    class_name: ClassName.PAGECLEAR,
    class_instr: InstructionType.EXECUTE,
    class_parameters: {},
  };

  const filter: ResponseFilter = {
    class_name: ClassName.PAGECLEAR,
    class_instr: InstructionType.ACKNOWLEDGE,
    class_parameters: {
      LASTHEADER: null,
    },
  };

  return { descriptor, filter };
}
