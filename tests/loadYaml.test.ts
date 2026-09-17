/** Ported from upstream tests/test_load_yaml.py */
import { describe, expect, it } from "vitest";
import { loadYaml, tryFixYaml } from "../src/utils/loadYaml.js";

describe("loadYaml", () => {
  it("loads valid YAML", () => {
    expect(loadYaml("name: John Smith\nage: 35")).toEqual({ name: "John Smith", age: 35 });
  });

  it("strips a ```yaml fence", () => {
    expect(loadYaml("```yaml\nlanguage: typescript\nnumber_of_tests: 3\n```")).toEqual({
      language: "typescript",
      number_of_tests: 3,
    });
  });

  it("fixes unquoted colons via keys_fix_yaml (first fallback)", () => {
    const yaml = `\
PR Feedback:
  Code feedback:
    - relevant file: pr_agent/settings/pr_description_prompts.toml
      suggestion: Consider a better name. [medium]
      relevant line: user="""PR Info: aaa
  Security concerns: No`;
    const out = loadYaml(yaml, ["relevant line:", "suggestion content:", "relevant file:"]) as Record<string, any>;
    expect(out["PR Feedback"]["Code feedback"][0]["relevant line"]).toBe('user="""PR Info: aaa');
    // Documented difference: CORE schema keeps "No" as a string (PyYAML 1.1 made it false).
    expect(out["PR Feedback"]["Security concerns"]).toBe("No");
  });

  it("second invalid case from upstream", () => {
    // Python's `\<newline>` in the upstream literal is a line continuation, so the string ends in "==: ".
    const yaml = "- relevant file: src/app.py:\n  suggestion content: The print statement is outside inside the if __name__ ==: ";
    expect(loadYaml(yaml, ["relevant line:", "suggestion content:", "relevant file:"])).toEqual([
      { "relevant file": "src/app.py:", "suggestion content": "The print statement is outside inside the if __name__ ==:" },
    ]);
  });

  it("extracts a yaml snippet", () => {
    expect(tryFixYaml("```yaml\nname: John Smith\nage: 35\n```")).toEqual({ name: "John Smith", age: 35 });
  });

  it("removes trailing invalid lines", () => {
    expect(tryFixYaml("language: python\nname: John Smith\nage: 35\ninvalid_line")).toEqual({
      language: "python",
      name: "John Smith",
      age: 35,
    });
  });

  it("parses chatty llama3-8b output", () => {
    const yaml = `\
here is the response:
language: python
new_tests:
- test_behavior: |
    aaa
  test_name: test_current_date
  test_code: |
    bbb
  test_tags: happy path    
hope this helps!
`;
    expect(tryFixYaml(yaml)).toEqual({
      "here is the response": null,
      language: "python",
      new_tests: [{ test_behavior: "aaa\n", test_name: "test_current_date", test_code: "bbb\n", test_tags: "happy path" }],
    });
  });

  it("returns nothing when no fallback can parse the input (upstream cases)", () => {
    expect(loadYaml("\nhere is the response\n\nlanguage: python\ntests:\n- test_behavior: |\naaa\ntest_name:")).toBeFalsy();
    expect(loadYaml("```yaml\ninvalid_yaml: [unclosed_list\n```")).toBeFalsy();
    expect(tryFixYaml("```yaml\n        key: [unclosed bracket\n        ```")).toBeFalsy();
  });

  it("duplicate keys: last wins (PyYAML behaviour)", () => {
    expect(loadYaml("a: 1\na: 2")).toEqual({ a: 2 });
  });
});
