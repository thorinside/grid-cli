import { getElementEvents } from "../protocol/codec.js";
import { ELEMENT_EVENTS, EVENT_NAMES, type EventType } from "./types.js";

export interface EventDescriptor {
  name: string;
  value: number;
  defaultConfig?: string;
}

const EVENT_NAME_ALIASES: Record<string, string> = {
  setup: "init",
  "midi rx": "midirx",
  midirx: "midirx",
  utility: "mapmode",
  map: "mapmode",
};

function normalizeEventName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function canonicalEventName(name: string): string {
  const normalized = normalizeEventName(name);
  return EVENT_NAME_ALIASES[normalized] ?? normalized;
}

export function getEventDescriptors(elementType: string): EventDescriptor[] {
  const protocolEvents = getElementEvents(elementType);
  if (protocolEvents && protocolEvents.length > 0) {
    return protocolEvents.map((event) => {
      const baseName = event.name || event.key || String(event.value);
      const canonical = canonicalEventName(baseName);
      return {
        name: canonical || String(event.value),
        value: event.value,
        defaultConfig: event.defaultConfig,
      };
    });
  }

  const fallback = ELEMENT_EVENTS[elementType] ?? ELEMENT_EVENTS.button;
  return fallback.map((eventType) => ({
    name: EVENT_NAMES[eventType] ?? String(eventType),
    value: eventType,
  }));
}

export function getEventNameForType(
  elementType: string,
  eventType: number,
): string {
  const descriptors = getEventDescriptors(elementType);
  const match = descriptors.find((desc) => desc.value === eventType);
  if (match) return match.name;
  return EVENT_NAMES[eventType as EventType] ?? String(eventType);
}

export function getEventTypeFromName(
  elementType: string,
  name: string,
): number | null {
  const canonical = canonicalEventName(name);
  const descriptors = getEventDescriptors(elementType);
  for (const desc of descriptors) {
    if (canonicalEventName(desc.name) === canonical) {
      return desc.value;
    }
  }

  for (const [value, label] of Object.entries(EVENT_NAMES)) {
    if (canonicalEventName(label) === canonical) {
      return Number(value);
    }
  }

  return null;
}
