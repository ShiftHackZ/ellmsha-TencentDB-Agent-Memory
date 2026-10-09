import { describe, expect, it } from "vitest";
import { parseFileBlocks } from "./file-protocol.js";

describe("Wiki FILE protocol", () => {
  it.each([">", ">>", ">>>"])("accepts a complete page with a %s opening suffix", (suffix) => {
    const body = "---\ntype: source\ntitle: Invoice\n---\n\nPrice times quantity is the total.\n";
    const parsed = parseFileBlocks(`<<<FILE path="wiki/sources/invoice.md"${suffix}\n${body}<<<END>>>`);
    expect(parsed.files).toEqual([{ path: "wiki/sources/invoice.md", content: body }]);
    expect(parsed.warnings).toEqual([]);
  });

  it("still rejects traversal, outside-wiki paths and truncated blocks", () => {
    const parsed = parseFileBlocks([
      '<<<FILE path="wiki/../../outside.md">\nprivate\n<<<END>>>',
      '<<<FILE path="/absolute.md">\nprivate\n<<<END>>>',
      '<<<FILE path="other/note.md">\nprivate\n<<<END>>>',
      '<<<FILE path="wiki/sources/truncated.md">\nunfinished',
    ].join("\n"));
    expect(parsed.files).toEqual([]);
    expect(parsed.warnings).toHaveLength(4);
  });
});
