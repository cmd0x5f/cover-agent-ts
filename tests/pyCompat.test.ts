import { describe, expect, it } from "vitest";
import { formatPyFloat, pyDictRepr, pyJsonDumps, pyStrRepr, tokenSortRatio } from "../src/utils/pyCompat.js";

describe("Python compatibility helpers", () => {
  it("pyStrRepr matches CPython repr()", () => {
    expect(pyStrRepr("")).toBe("''");
    expect(pyStrRepr("it's")).toBe(`"it's"`);
    expect(pyStrRepr(`it's "quoted"`)).toBe(`'it\\'s "quoted"'`);
    expect(pyStrRepr("a\nb\tc\\d")).toBe("'a\\nb\\tc\\\\d'");
    expect(pyStrRepr("\x00\x7f\xa0")).toBe("'\\x00\\x7f\\xa0'");
    expect(pyStrRepr("héllo ✓ 😀")).toBe("'héllo ✓ 😀'");
    expect(pyStrRepr("\u2028")).toBe("'\\u2028'");
  });

  it("pyDictRepr", () => {
    expect(pyDictRepr({ system: "", user: "hi" })).toBe("{'system': '', 'user': 'hi'}");
  });

  it("formatPyFloat mirrors str(round(x, 2))", () => {
    expect(formatPyFloat(50)).toBe("50.0");
    expect(formatPyFloat(48.3050847)).toBe("48.31");
    expect(formatPyFloat(0)).toBe("0.0");
    expect(formatPyFloat(64.1)).toBe("64.1");
  });

  it("pyJsonDumps uses Python separators and ensure_ascii", () => {
    expect(pyJsonDumps({ a: "x", b: [1, 2], c: "é" })).toBe('{"a": "x", "b": [1, 2], "c": "\\u00e9"}');
  });

  it("tokenSortRatio ignores token order, case and punctuation", () => {
    expect(tokenSortRatio("Hello, World!", "world hello")).toBe(100);
    expect(tokenSortRatio("abc", "xyz")).toBeLessThan(50);
  });
});
