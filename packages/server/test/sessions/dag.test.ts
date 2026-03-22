import { describe, expect, it } from "vitest";
import {
  type RawSessionMessage,
  buildDag,
  collectAllToolResultIds,
  findOrphanedToolUses,
  findSiblingToolBranches,
  findSiblingToolResults,
} from "../../src/sessions/dag.js";

describe("buildDag", () => {
  it("builds linear chain correctly", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      { type: "user", uuid: "c", parentUuid: "b" },
    ];

    const result = buildDag(messages);

    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a", "b", "c"]);
    expect(result.tip?.uuid).toBe("c");
    expect(result.activeBranchUuids.size).toBe(3);
  });

  it("filters dead branches, keeping latest tip", () => {
    // Structure:
    // a -> b -> c (dead branch, earlier lineIndex for tip)
    //   \-> d -> e (active branch, tip at lineIndex 4)
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      { type: "user", uuid: "c", parentUuid: "b" }, // dead branch tip at index 2
      { type: "assistant", uuid: "d", parentUuid: "a" }, // branch from a
      { type: "user", uuid: "e", parentUuid: "d" }, // active tip at index 4
    ];

    const result = buildDag(messages);

    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a", "d", "e"]);
    expect(result.tip?.uuid).toBe("e");
    expect(result.activeBranchUuids.has("b")).toBe(false);
    expect(result.activeBranchUuids.has("c")).toBe(false);
  });

  it("handles messages without uuid (internal types)", () => {
    const messages: RawSessionMessage[] = [
      { type: "queue-operation" }, // no uuid - skipped
      { type: "user", uuid: "a", parentUuid: null },
      { type: "file-history-snapshot" }, // no uuid - skipped
      { type: "assistant", uuid: "b", parentUuid: "a" },
    ];

    const result = buildDag(messages);

    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a", "b"]);
  });

  it("selects latest tip when multiple tips exist", () => {
    // Two independent chains (two roots)
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null }, // chain 1 root
      { type: "assistant", uuid: "b", parentUuid: "a" }, // chain 1 tip at index 1
      { type: "user", uuid: "x", parentUuid: null }, // chain 2 root
      { type: "assistant", uuid: "y", parentUuid: "x" }, // chain 2 tip at index 3
    ];

    const result = buildDag(messages);

    // Should select chain 2 (tip y at index 3 > tip b at index 1)
    expect(result.tip?.uuid).toBe("y");
    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["x", "y"]);
  });

  it("handles empty input", () => {
    const result = buildDag([]);

    expect(result.activeBranch).toEqual([]);
    expect(result.tip).toBeNull();
    expect(result.activeBranchUuids.size).toBe(0);
  });

  it("handles single message", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
    ];

    const result = buildDag(messages);

    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a"]);
    expect(result.tip?.uuid).toBe("a");
  });

  it("handles broken parentUuid chain gracefully", () => {
    // Message b references non-existent parent
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "nonexistent" },
      { type: "user", uuid: "c", parentUuid: "a" }, // continues from a
    ];

    const result = buildDag(messages);

    // b is orphaned (references nonexistent parent), so its chain stops
    // c at index 2 is later than b at index 1, so c's chain is selected
    expect(result.tip?.uuid).toBe("c");
    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a", "c"]);
  });

  it("preserves lineIndex in nodes", () => {
    const messages: RawSessionMessage[] = [
      { type: "queue-operation" }, // index 0, skipped
      { type: "user", uuid: "a", parentUuid: null }, // index 1
      { type: "file-history-snapshot" }, // index 2, skipped
      { type: "assistant", uuid: "b", parentUuid: "a" }, // index 3
    ];

    const result = buildDag(messages);

    expect(result.activeBranch[0]?.lineIndex).toBe(1);
    expect(result.activeBranch[1]?.lineIndex).toBe(3);
  });
});

describe("findOrphanedToolUses", () => {
  it("identifies tool_use without matching tool_result", () => {
    const messages: RawSessionMessage[] = [
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        message: {
          content: [{ type: "tool_use", id: "tool-1" }],
        },
      },
      {
        type: "user",
        uuid: "b",
        parentUuid: "a",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1" }],
        },
      },
      {
        type: "assistant",
        uuid: "c",
        parentUuid: "b",
        message: {
          content: [{ type: "tool_use", id: "tool-2" }],
        },
      },
      // No tool_result for tool-2
    ];
    const { activeBranch } = buildDag(messages);
    const allToolResultIds = collectAllToolResultIds(messages);

    const orphaned = findOrphanedToolUses(activeBranch, allToolResultIds);

    expect(orphaned.has("tool-1")).toBe(false);
    expect(orphaned.has("tool-2")).toBe(true);
    expect(orphaned.size).toBe(1);
  });

  it("returns empty set when all tools have results", () => {
    const messages: RawSessionMessage[] = [
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        message: {
          content: [
            { type: "tool_use", id: "tool-1" },
            { type: "tool_use", id: "tool-2" },
          ],
        },
      },
      {
        type: "user",
        uuid: "b",
        parentUuid: "a",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1" },
            { type: "tool_result", tool_use_id: "tool-2" },
          ],
        },
      },
    ];
    const { activeBranch } = buildDag(messages);
    const allToolResultIds = collectAllToolResultIds(messages);

    const orphaned = findOrphanedToolUses(activeBranch, allToolResultIds);

    expect(orphaned.size).toBe(0);
  });

  it("handles messages with string content", () => {
    const messages: RawSessionMessage[] = [
      {
        type: "user",
        uuid: "a",
        parentUuid: null,
        message: {
          content: "Hello, this is a string message",
        },
      },
    ];
    const { activeBranch } = buildDag(messages);
    const allToolResultIds = collectAllToolResultIds(messages);

    const orphaned = findOrphanedToolUses(activeBranch, allToolResultIds);

    expect(orphaned.size).toBe(0);
  });

  it("handles messages without content", () => {
    const messages: RawSessionMessage[] = [
      {
        type: "user",
        uuid: "a",
        parentUuid: null,
      },
    ];
    const { activeBranch } = buildDag(messages);
    const allToolResultIds = collectAllToolResultIds(messages);

    const orphaned = findOrphanedToolUses(activeBranch, allToolResultIds);

    expect(orphaned.size).toBe(0);
  });

  it("handles multiple orphaned tools", () => {
    const messages: RawSessionMessage[] = [
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        message: {
          content: [
            { type: "tool_use", id: "tool-1" },
            { type: "tool_use", id: "tool-2" },
            { type: "tool_use", id: "tool-3" },
          ],
        },
      },
      {
        type: "user",
        uuid: "b",
        parentUuid: "a",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-2" }],
        },
      },
    ];
    const { activeBranch } = buildDag(messages);
    const allToolResultIds = collectAllToolResultIds(messages);

    const orphaned = findOrphanedToolUses(activeBranch, allToolResultIds);

    expect(orphaned.has("tool-1")).toBe(true);
    expect(orphaned.has("tool-2")).toBe(false);
    expect(orphaned.has("tool-3")).toBe(true);
    expect(orphaned.size).toBe(2);
  });

  it("handles empty active branch", () => {
    const orphaned = findOrphanedToolUses([], new Set());

    expect(orphaned.size).toBe(0);
  });
});

describe("buildDag with compaction", () => {
  it("follows logicalParentUuid across single compact_boundary", () => {
    // Pre-compaction messages
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      { type: "user", uuid: "c", parentUuid: "b" },
      // Compact boundary - parentUuid is null but logicalParentUuid points to pre-compaction
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "c",
      },
      // Post-compaction messages continue from compact boundary
      { type: "user", uuid: "d", parentUuid: "compact-1" },
      { type: "assistant", uuid: "e", parentUuid: "d" },
    ];

    const result = buildDag(messages);

    // Should include all messages: pre-compaction + compact_boundary + post-compaction
    expect(result.activeBranch.map((n) => n.uuid)).toEqual([
      "a",
      "b",
      "c",
      "compact-1",
      "d",
      "e",
    ]);
    expect(result.tip?.uuid).toBe("e");
    expect(result.activeBranchUuids.size).toBe(6);
  });

  it("follows multiple compact_boundary nodes in chain", () => {
    // First conversation segment
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      // First compaction
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "b",
      },
      // Second segment
      { type: "user", uuid: "c", parentUuid: "compact-1" },
      { type: "assistant", uuid: "d", parentUuid: "c" },
      // Second compaction
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-2",
        parentUuid: null,
        logicalParentUuid: "d",
      },
      // Third segment
      { type: "user", uuid: "e", parentUuid: "compact-2" },
      { type: "assistant", uuid: "f", parentUuid: "e" },
    ];

    const result = buildDag(messages);

    // Should include all segments connected through compact boundaries
    expect(result.activeBranch.map((n) => n.uuid)).toEqual([
      "a",
      "b",
      "compact-1",
      "c",
      "d",
      "compact-2",
      "e",
      "f",
    ]);
    expect(result.tip?.uuid).toBe("f");
  });

  it("handles compact_boundary without logicalParentUuid (stops at boundary)", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      // Compact boundary without logicalParentUuid (shouldn't happen, but be defensive)
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        // No logicalParentUuid
      },
      { type: "user", uuid: "c", parentUuid: "compact-1" },
    ];

    const result = buildDag(messages);

    // Branch 1 (a→b) has 2 conversation messages, branch 2 (compact-1→c) has 1
    // Algorithm prefers more conversation messages, so branch 1 is selected
    expect(result.activeBranch.map((n) => n.uuid)).toEqual(["a", "b"]);
    expect(result.tip?.uuid).toBe("b");
  });

  it("bridges across compact_boundary with broken logicalParentUuid using file-order fallback", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      // Compact boundary pointing to non-existent message
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "nonexistent",
      },
      { type: "user", uuid: "b", parentUuid: "compact-1" },
    ];

    const result = buildDag(messages);

    // Should bridge to "a" via file-order fallback since logicalParentUuid is broken
    expect(result.activeBranch.map((n) => n.uuid)).toEqual([
      "a",
      "compact-1",
      "b",
    ]);
    expect(result.tip?.uuid).toBe("b");
  });

  it("bridges across broken logicalParentUuid to include pre-compaction messages", () => {
    // Real-world scenario: long pre-compaction history, compact boundary with
    // unresolvable logicalParentUuid, shorter post-compaction continuation.
    // The DAG should bridge to the pre-compaction messages via file-order fallback.
    const t = (m: number) => `2025-01-01T00:${String(m).padStart(2, "0")}:00Z`;
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "pre-1", parentUuid: null, timestamp: t(0) },
      {
        type: "assistant",
        uuid: "pre-2",
        parentUuid: "pre-1",
        timestamp: t(1),
      },
      { type: "user", uuid: "pre-3", parentUuid: "pre-2", timestamp: t(2) },
      {
        type: "assistant",
        uuid: "pre-4",
        parentUuid: "pre-3",
        timestamp: t(3),
      },
      { type: "user", uuid: "pre-5", parentUuid: "pre-4", timestamp: t(4) },
      {
        type: "assistant",
        uuid: "pre-6",
        parentUuid: "pre-5",
        timestamp: t(5),
      },
      { type: "user", uuid: "pre-7", parentUuid: "pre-6", timestamp: t(6) },
      {
        type: "assistant",
        uuid: "pre-8",
        parentUuid: "pre-7",
        timestamp: t(7),
      },
      // Compact boundary - logicalParentUuid doesn't exist in file
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "nonexistent",
        timestamp: t(8),
      },
      // Short post-compaction continuation (more recent timestamps)
      {
        type: "user",
        uuid: "post-1",
        parentUuid: "compact-1",
        timestamp: t(9),
      },
      {
        type: "assistant",
        uuid: "post-2",
        parentUuid: "post-1",
        timestamp: t(10),
      },
    ];

    const result = buildDag(messages);

    // Post-compaction tip should be selected, and the DAG should bridge back
    // to pre-compaction messages through the file-order fallback
    expect(result.tip?.uuid).toBe("post-2");
    expect(result.activeBranch.map((n) => n.uuid)).toEqual([
      "pre-1",
      "pre-2",
      "pre-3",
      "pre-4",
      "pre-5",
      "pre-6",
      "pre-7",
      "pre-8",
      "compact-1",
      "post-1",
      "post-2",
    ]);
  });

  it("bridges across multiple broken logicalParentUuids in chain", () => {
    // Real-world scenario: session with 2 compact boundaries, both with
    // unresolvable logicalParentUuids (continued from parent session)
    const messages: RawSessionMessage[] = [
      // Pre-compaction messages
      { type: "user", uuid: "a", parentUuid: null },
      { type: "assistant", uuid: "b", parentUuid: "a" },
      { type: "user", uuid: "c", parentUuid: "b" },
      // First compaction - logicalParentUuid broken
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "nonexistent-1",
      },
      // Between compactions
      { type: "user", uuid: "d", parentUuid: "compact-1" },
      { type: "assistant", uuid: "e", parentUuid: "d" },
      // Second compaction - logicalParentUuid also broken
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-2",
        parentUuid: null,
        logicalParentUuid: "nonexistent-2",
      },
      // Post second compaction
      { type: "user", uuid: "f", parentUuid: "compact-2" },
      { type: "assistant", uuid: "g", parentUuid: "f" },
    ];

    const result = buildDag(messages);

    // Should bridge all the way back through both broken boundaries
    expect(result.tip?.uuid).toBe("g");
    expect(result.activeBranch.map((n) => n.uuid)).toEqual([
      "a",
      "b",
      "c",
      "compact-1",
      "d",
      "e",
      "compact-2",
      "f",
      "g",
    ]);
  });

  it("includes compact_boundary in activeBranchUuids", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null },
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "a",
      },
      { type: "user", uuid: "b", parentUuid: "compact-1" },
    ];

    const result = buildDag(messages);

    expect(result.activeBranchUuids.has("compact-1")).toBe(true);
  });

  it("preserves lineIndex across compaction boundary", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "a", parentUuid: null }, // index 0
      { type: "assistant", uuid: "b", parentUuid: "a" }, // index 1
      {
        type: "system",
        subtype: "compact_boundary",
        uuid: "compact-1",
        parentUuid: null,
        logicalParentUuid: "b",
      }, // index 2
      { type: "user", uuid: "c", parentUuid: "compact-1" }, // index 3
    ];

    const result = buildDag(messages);

    expect(result.activeBranch[0]?.lineIndex).toBe(0);
    expect(result.activeBranch[1]?.lineIndex).toBe(1);
    expect(result.activeBranch[2]?.lineIndex).toBe(2); // compact_boundary
    expect(result.activeBranch[3]?.lineIndex).toBe(3);
  });
});

describe("findSiblingToolResults", () => {
  it("finds tool_result on sibling branch for parallel tool calls", () => {
    // This simulates the parallel tool call pattern:
    // tool_use #1 (Read file A)
    // ├── tool_use #2 (Read file B) ← active branch continues here
    // │   └── tool_result for file B
    // └── tool_result for file A (sibling branch)
    const messages: RawSessionMessage[] = [
      {
        type: "assistant",
        uuid: "tool-1",
        parentUuid: null,
        message: {
          content: [{ type: "tool_use", id: "read-1" }],
        },
      },
      {
        type: "assistant",
        uuid: "tool-2",
        parentUuid: "tool-1", // continues from tool-1
        message: {
          content: [{ type: "tool_use", id: "read-2" }],
        },
      },
      {
        type: "user",
        uuid: "result-2",
        parentUuid: "tool-2", // result for tool-2, on active branch
        message: {
          content: [{ type: "tool_result", tool_use_id: "read-2" }],
        },
      },
      {
        type: "user",
        uuid: "result-1",
        parentUuid: "tool-1", // result for tool-1, sibling of tool-2
        message: {
          content: [{ type: "tool_result", tool_use_id: "read-1" }],
        },
      },
    ];

    const { activeBranch } = buildDag(messages);
    const siblingResults = findSiblingToolResults(activeBranch, messages);

    // Active branch should be: tool-1 → tool-2 → result-2
    expect(activeBranch.map((n) => n.uuid)).toEqual([
      "tool-1",
      "tool-2",
      "result-2",
    ]);

    // Sibling result should be found for read-1
    expect(siblingResults.length).toBe(1);
    expect(siblingResults[0]?.toolUseIds).toContain("read-1");
    expect(siblingResults[0]?.parentUuid).toBe("tool-1");
  });

  it("returns empty array when all tool_results are on active branch", () => {
    const messages: RawSessionMessage[] = [
      {
        type: "assistant",
        uuid: "a",
        parentUuid: null,
        message: {
          content: [{ type: "tool_use", id: "tool-1" }],
        },
      },
      {
        type: "user",
        uuid: "b",
        parentUuid: "a",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tool-1" }],
        },
      },
    ];

    const { activeBranch } = buildDag(messages);
    const siblingResults = findSiblingToolResults(activeBranch, messages);

    expect(siblingResults.length).toBe(0);
  });

  it("ignores tool_results for tools not on active branch", () => {
    // tool_result exists but its tool_use is on a dead branch
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "root", parentUuid: null },
      {
        type: "assistant",
        uuid: "dead-tool",
        parentUuid: "root",
        message: {
          content: [{ type: "tool_use", id: "dead-tool-use" }],
        },
      },
      {
        type: "user",
        uuid: "dead-result",
        parentUuid: "dead-tool",
        message: {
          content: [{ type: "tool_result", tool_use_id: "dead-tool-use" }],
        },
      },
      // Active branch continues differently
      {
        type: "assistant",
        uuid: "active",
        parentUuid: "root",
        message: {
          content: [{ type: "text", text: "Active message" }],
        },
      },
      {
        type: "user",
        uuid: "tip",
        parentUuid: "active",
      },
    ];

    const { activeBranch } = buildDag(messages);
    const siblingResults = findSiblingToolResults(activeBranch, messages);

    // Active branch should be: root → active → tip
    expect(activeBranch.map((n) => n.uuid)).toEqual(["root", "active", "tip"]);

    // No sibling results because dead-tool-use is not on active branch
    expect(siblingResults.length).toBe(0);
  });

  it("handles multiple tool_results in same sibling message", () => {
    // When multiple parallel tools complete, their results may be in one message
    const messages: RawSessionMessage[] = [
      {
        type: "assistant",
        uuid: "tools",
        parentUuid: null,
        message: {
          content: [
            { type: "tool_use", id: "tool-1" },
            { type: "tool_use", id: "tool-2" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "continues",
        parentUuid: "tools",
        message: {
          content: [{ type: "text", text: "Continuing..." }],
        },
      },
      {
        type: "user",
        uuid: "tip",
        parentUuid: "continues", // extends the active branch
      },
      {
        type: "user",
        uuid: "sibling-results",
        parentUuid: "tools", // sibling of "continues"
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tool-1" },
            { type: "tool_result", tool_use_id: "tool-2" },
          ],
        },
      },
    ];

    const { activeBranch } = buildDag(messages);
    const siblingResults = findSiblingToolResults(activeBranch, messages);

    // Active branch should be: tools → continues → tip (length 3)
    // sibling-results is a dead branch (length 2)
    expect(activeBranch.map((n) => n.uuid)).toEqual([
      "tools",
      "continues",
      "tip",
    ]);

    expect(siblingResults.length).toBe(1);
    expect(siblingResults[0]?.toolUseIds).toContain("tool-1");
    expect(siblingResults[0]?.toolUseIds).toContain("tool-2");
  });

  it("finds separate sibling tool_results for 3 parallel Tasks with same parentUuid", () => {
    // Real-world scenario: Claude spawns 3 parallel Task calls
    // Each Task produces its own tool_result message, all with same parentUuid
    // The DAG selects one as active, the other 2 are siblings
    const messages: RawSessionMessage[] = [
      {
        type: "assistant",
        uuid: "msg-1",
        parentUuid: null,
        message: {
          content: [
            { type: "tool_use", id: "task-1", name: "Task" },
            { type: "tool_use", id: "task-2", name: "Task" },
            { type: "tool_use", id: "task-3", name: "Task" },
          ],
        },
      },
      // All 3 results have the same parentUuid (siblings of each other)
      {
        type: "user",
        uuid: "result-1",
        parentUuid: "msg-1",
        message: {
          content: [{ type: "tool_result", tool_use_id: "task-1" }],
        },
      },
      {
        type: "user",
        uuid: "result-2",
        parentUuid: "msg-1",
        message: {
          content: [{ type: "tool_result", tool_use_id: "task-2" }],
        },
      },
      {
        type: "user",
        uuid: "result-3",
        parentUuid: "msg-1",
        message: {
          content: [{ type: "tool_result", tool_use_id: "task-3" }],
        },
      },
    ];

    const { activeBranch } = buildDag(messages);
    const siblingResults = findSiblingToolResults(activeBranch, messages);

    // Active branch: msg-1 → result-3 (last by lineIndex)
    // This is because all results have same conversation length (1 user/assistant message each)
    // and result-3 has the highest lineIndex
    expect(activeBranch.map((n) => n.uuid)).toEqual(["msg-1", "result-3"]);

    // The other 2 results should be found as siblings
    expect(siblingResults.length).toBe(2);

    // Extract all found tool_use_ids from siblings
    const siblingToolUseIds = siblingResults.flatMap((s) => s.toolUseIds);
    expect(siblingToolUseIds).toContain("task-1");
    expect(siblingToolUseIds).toContain("task-2");
    // task-3 is on active branch, not a sibling
    expect(siblingToolUseIds).not.toContain("task-3");

    // All siblings should have parentUuid pointing to msg-1
    for (const sibling of siblingResults) {
      expect(sibling.parentUuid).toBe("msg-1");
    }
  });

  it("finds chained parallel Tasks where later tasks end up on dead branches", () => {
    // Real-world scenario: Claude spawns 3 parallel Tasks as CHAINED messages
    // Each Task is in a separate assistant message that chains from the previous
    // When results come back, the conversation continues from the FIRST result,
    // leaving the other tasks on dead branches
    //
    // Structure:
    // text-msg → task-1-msg → task-2-msg → task-3-msg → result-3
    //                │              └──→ result-2
    //                └──→ result-1 → cont-1 → cont-2 → ... (ACTIVE BRANCH)
    const messages: RawSessionMessage[] = [
      {
        type: "assistant",
        uuid: "text-msg",
        parentUuid: null,
        message: { content: [{ type: "text", text: "Let me explore..." }] },
      },
      {
        type: "assistant",
        uuid: "task-1-msg",
        parentUuid: "text-msg",
        message: {
          content: [{ type: "tool_use", id: "task-1-id", name: "Task" }],
        },
      },
      {
        type: "assistant",
        uuid: "task-2-msg",
        parentUuid: "task-1-msg",
        message: {
          content: [{ type: "tool_use", id: "task-2-id", name: "Task" }],
        },
      },
      {
        type: "assistant",
        uuid: "task-3-msg",
        parentUuid: "task-2-msg",
        message: {
          content: [{ type: "tool_use", id: "task-3-id", name: "Task" }],
        },
      },
      // Results come back - task-3 finishes first
      {
        type: "user",
        uuid: "result-3",
        parentUuid: "task-3-msg",
        message: {
          content: [{ type: "tool_result", tool_use_id: "task-3-id" }],
        },
      },
      {
        type: "user",
        uuid: "result-2",
        parentUuid: "task-2-msg",
        message: {
          content: [{ type: "tool_result", tool_use_id: "task-2-id" }],
        },
      },
      {
        type: "user",
        uuid: "result-1",
        parentUuid: "task-1-msg",
        message: {
          content: [{ type: "tool_result", tool_use_id: "task-1-id" }],
        },
      },
      // Conversation continues significantly from result-1 (making it the active branch)
      // This is what happens in real sessions - Claude continues working after all tasks complete
      {
        type: "assistant",
        uuid: "cont-1",
        parentUuid: "result-1",
        message: { content: [{ type: "text", text: "Excellent..." }] },
      },
      {
        type: "user",
        uuid: "cont-2",
        parentUuid: "cont-1",
        message: { content: "Continue please" },
      },
      {
        type: "assistant",
        uuid: "cont-3",
        parentUuid: "cont-2",
        message: { content: [{ type: "text", text: "Sure..." }] },
      },
      {
        type: "user",
        uuid: "cont-4",
        parentUuid: "cont-3",
        message: { content: "More" },
      },
    ];

    const { activeBranch } = buildDag(messages);

    // Active branch follows the longest path through result-1 → cont-1 → cont-2 → cont-3 → cont-4
    // This is 7 nodes vs 5 nodes for the task-3 path
    expect(activeBranch.map((n) => n.uuid)).toEqual([
      "text-msg",
      "task-1-msg",
      "result-1",
      "cont-1",
      "cont-2",
      "cont-3",
      "cont-4",
    ]);

    // The old function findSiblingToolResults only finds results for tool_uses on the ACTIVE branch.
    // task-2-id and task-3-id are NOT on the active branch, so it finds 0.
    const siblingResults = findSiblingToolResults(activeBranch, messages);
    expect(siblingResults.length).toBe(0);

    // The new function findSiblingToolBranches finds complete sibling branches
    // that contain tool_use/tool_result pairs, even when the tool_use is on a dead branch.
    const siblingBranches = findSiblingToolBranches(activeBranch, messages);

    // Should find 1 sibling branch starting from task-1-msg (the branch point)
    // This branch contains: task-2-msg, task-3-msg, result-3, result-2
    expect(siblingBranches.length).toBe(1);
    expect(siblingBranches[0]?.branchPoint).toBe("task-1-msg");

    // The sibling branch should contain all 4 nodes
    const siblingUuids = siblingBranches[0]?.nodes.map((n) => n.uuid) ?? [];
    expect(siblingUuids).toContain("task-2-msg");
    expect(siblingUuids).toContain("task-3-msg");
    expect(siblingUuids).toContain("result-2");
    expect(siblingUuids).toContain("result-3");

    // Both task-2 and task-3 should be marked as completed
    expect(siblingBranches[0]?.completedToolUseIds).toContain("task-2-id");
    expect(siblingBranches[0]?.completedToolUseIds).toContain("task-3-id");
  });
});

describe("progress messages", () => {
  it("excludes progress chain and correctly parents subsequent messages", () => {
    // Real-world scenario: Agent tool_use spawns subagent, progress messages
    // chain off the tool_use node, then the SDK parents the next user message
    // to the last progress message instead of the conversation continuation.
    //
    // Structure:
    //   user-1 → assistant-agent-tooluse → user-agent-result → assistant-text → assistant-final
    //                                    ↘ progress-1 → progress-2 → progress-3 → user-2 → assistant-reply
    //
    // Without the fix, active branch goes through progress chain, missing assistant-text and assistant-final.
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "u1", parentUuid: null },
      {
        type: "assistant",
        uuid: "agent-tooluse",
        parentUuid: "u1",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "agent-id", name: "Agent", input: {} },
          ],
        },
      },
      {
        type: "user",
        uuid: "agent-result",
        parentUuid: "agent-tooluse",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "agent-id", content: "done" },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "text-after-agent",
        parentUuid: "agent-result",
      },
      { type: "assistant", uuid: "final-text", parentUuid: "text-after-agent" },
      // Progress chain branches off agent-tooluse
      { type: "progress", uuid: "p1", parentUuid: "agent-tooluse" },
      { type: "progress", uuid: "p2", parentUuid: "p1" },
      { type: "progress", uuid: "p3", parentUuid: "p2" },
      // Next user message parents to last progress (SDK behavior)
      { type: "user", uuid: "u2", parentUuid: "p3" },
      { type: "assistant", uuid: "reply", parentUuid: "u2" },
    ];

    const result = buildDag(messages);

    // Progress messages should NOT appear in the active branch
    const uuids = result.activeBranch.map((n) => n.uuid);
    expect(uuids).not.toContain("p1");
    expect(uuids).not.toContain("p2");
    expect(uuids).not.toContain("p3");

    // The conversation after the agent result MUST be on the active branch
    expect(uuids).toContain("text-after-agent");
    expect(uuids).toContain("final-text");

    // The new user message should also be on the active branch
    expect(uuids).toContain("u2");
    expect(uuids).toContain("reply");

    // Tip should be the reply
    expect(result.tip?.uuid).toBe("reply");
  });

  it("handles single progress message between conversation turns", () => {
    // Simpler case: one progress message, not a long chain
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "u1", parentUuid: null },
      { type: "assistant", uuid: "a1", parentUuid: "u1" },
      { type: "progress", uuid: "p1", parentUuid: "a1" },
      { type: "user", uuid: "u2", parentUuid: "p1" },
      { type: "assistant", uuid: "a2", parentUuid: "u2" },
    ];

    const result = buildDag(messages);
    const uuids = result.activeBranch.map((n) => n.uuid);

    expect(uuids).toEqual(["u1", "a1", "u2", "a2"]);
    expect(uuids).not.toContain("p1");
  });

  it("does not duplicate a progress-resumed subtree as a sibling branch", () => {
    const messages: RawSessionMessage[] = [
      { type: "user", uuid: "u1", parentUuid: null },
      { type: "assistant", uuid: "a1", parentUuid: "u1" },
      { type: "user", uuid: "u2", parentUuid: "a1" },
      { type: "assistant", uuid: "thinking", parentUuid: "u2" },
      { type: "assistant", uuid: "read-msg", parentUuid: "thinking" },
      {
        type: "assistant",
        uuid: "read-tool",
        parentUuid: "read-msg",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "read-id", name: "Read", input: {} },
          ],
        },
      },
      {
        type: "user",
        uuid: "read-result",
        parentUuid: "read-tool",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "read-id",
              content: "read done",
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "edit-msg",
        parentUuid: "read-result",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "edit-id", name: "Edit", input: {} },
          ],
        },
      },
      {
        type: "user",
        uuid: "edit-result",
        parentUuid: "edit-msg",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "edit-id",
              content: "edit done",
            },
          ],
        },
      },
      { type: "assistant", uuid: "edit-final", parentUuid: "edit-result" },
      { type: "progress", uuid: "p1", parentUuid: "read-tool" },
      { type: "progress", uuid: "p2", parentUuid: "p1" },
      { type: "user", uuid: "thanks", parentUuid: "p2" },
      { type: "assistant", uuid: "welcome", parentUuid: "thanks" },
      { type: "user", uuid: "launch", parentUuid: "welcome" },
      {
        type: "assistant",
        uuid: "agent-msg",
        parentUuid: "launch",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "agent-id", name: "Agent", input: {} },
          ],
        },
      },
      {
        type: "user",
        uuid: "agent-result",
        parentUuid: "agent-msg",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "agent-id",
              content: "agent done",
            },
          ],
        },
      },
      { type: "assistant", uuid: "removed", parentUuid: "agent-result" },
    ];

    const result = buildDag(messages);

    expect(result.activeBranch.map((node) => node.uuid)).toEqual([
      "u1",
      "a1",
      "u2",
      "thinking",
      "read-msg",
      "read-tool",
      "read-result",
      "edit-msg",
      "edit-result",
      "edit-final",
      "thanks",
      "welcome",
      "launch",
      "agent-msg",
      "agent-result",
      "removed",
    ]);

    const siblingBranches = findSiblingToolBranches(
      result.activeBranch,
      messages,
    );
    expect(siblingBranches).toEqual([]);
  });
});
