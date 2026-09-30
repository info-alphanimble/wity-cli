import { describe, expect, it } from "vitest";
import { bar, clean, cost, painter, pct, shouldColor } from "../src/output.ts";

const plain = painter(false);

describe("pct", () => {
  it("prints 2 decimals", () => {
    expect(pct(0.9124)).toBe("91.24%");
    expect(pct(0.5)).toBe("50.00%");
  });

  it("never prints a tiny or huge probability as 0% or 100%", () => {
    expect(pct(0.0000275)).toBe("<0.01%");
    expect(pct(0.9999544)).toBe(">99.99%");
    expect(pct(0)).toBe("0%");
    expect(pct(1)).toBe("100%");
  });
});

describe("bar", () => {
  it("is always the same width", () => {
    for (const p of [0, 0.01, 0.333, 0.5, 0.999, 1]) expect([...bar(p, 20, plain, "green")]).toHaveLength(20);
  });

  it("fills in eighths", () => {
    expect(bar(0.5, 4, plain, "green")).toBe("██··");
    expect(bar(1 / 16, 4, plain, "green")).toBe("▎···");
  });
});

describe("clean", () => {
  it("removes escape codes and control characters, so text can't restyle the terminal", () => {
    expect(clean("\x1b[31mred\x1b[0m")).toBe("red");
    expect(clean("line one\nline two\r\x07")).toBe("line one line two");
    expect(clean("\x1b]0;new title\x07ok")).toBe("ok");
  });
});

describe("cost", () => {
  it("shows small costs with enough decimals to be non-zero", () => {
    expect(cost(287)).toBe("$0.000012");
    expect(cost(1_000_000)).toBe("$0.04");
    expect(cost(0)).toBe("$0");
  });
});

describe("shouldColor", () => {
  const tty = { write: () => {}, isTTY: true };
  it("follows NO_COLOR, FORCE_COLOR and TERM=dumb", () => {
    expect(shouldColor({}, tty)).toBe(true);
    expect(shouldColor({ NO_COLOR: "1" }, tty)).toBe(false);
    expect(shouldColor({ TERM: "dumb" }, tty)).toBe(false);
    expect(shouldColor({ FORCE_COLOR: "1" }, { write: () => {}, isTTY: false })).toBe(true);
    expect(shouldColor({}, { write: () => {}, isTTY: false })).toBe(false);
  });
});
