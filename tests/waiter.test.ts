import { describe, it, expect } from "vitest";
import { matchesFilter } from "../src/protocol/waiter.js";

describe("matchesFilter", () => {
  it("matches numeric filters against numeric strings", () => {
    const message = {
      brc_parameters: { SX: "0", SY: "-1" },
      class_name: "CONFIG",
      class_instr: "REPORT",
      class_parameters: { PAGENUMBER: "0", ELEMENTNUMBER: "1", EVENTTYPE: "3" },
    };

    const filter = {
      brc_parameters: { SX: 0, SY: -1 },
      class_name: "CONFIG",
      class_instr: "REPORT",
      class_parameters: { PAGENUMBER: 0, ELEMENTNUMBER: 1, EVENTTYPE: 3 },
    };

    expect(matchesFilter(message, filter)).toBe(true);
  });
});
