/**
 * DAG (Directed Acyclic Graph) utilities for JSONL conversation parsing.
 *
 * Claude Code JSONL files are not linear logs - they form a DAG where each
 * message has a `parentUuid` pointing to its predecessor. This enables:
 * - Conversation branching (forking from any point)
 * - Dead branches (abandoned paths remain in file but are unreachable)
 * - Clean recovery (resumption picks any node as continuation point)
 */

import {
  type ClaudeSessionEntry,
  getLogicalParentUuid,
  getMessageContent,
} from "@yep-anywhere/shared";

/** A node in the conversation DAG */
export interface DagNode {
  uuid: string;
  parentUuid: string | null;
  /** Original position in JSONL file (0-indexed line number) */
  lineIndex: number;
  raw: ClaudeSessionEntry;
}

/** Info about an alternate branch (not selected as active) */
export interface AlternateBranch {
  /** The tip node of this branch */
  tipUuid: string;
  /** Number of messages from root to tip */
  length: number;
  /** Type of the tip message (user/assistant) */
  tipType: string;
}

/** Result of building and traversing the DAG */
export interface DagResult {
  /** Messages on the active branch, in conversation order (root to tip) */
  activeBranch: DagNode[];
  /** UUIDs of all messages on the active branch (for quick lookup) */
  activeBranchUuids: Set<string>;
  /** The tip node (most recent message with no children), or null if empty */
  tip: DagNode | null;
  /** Whether the session has multiple branches (forks detected) */
  hasBranches: boolean;
  /** Info about alternate branches not selected as active */
  alternateBranches: AlternateBranch[];
}

/** Message types that count as conversation (not internal/progress) */
const CONVERSATION_TYPES = new Set(["user", "assistant"]);

/**
 * Collect UUIDs of all progress messages.
 * Progress messages (subagent status updates) form long chains branching off
 * tool_use nodes. The SDK parents the next user message to the last progress
 * message, which causes the real conversation to end up on a dead branch.
 * We exclude them from the DAG and use lineIndex fallback for any node
 * whose parent was a progress message.
 */
function collectProgressUuids(messages: ClaudeSessionEntry[]): Set<string> {
  const uuids = new Set<string>();
  for (const msg of messages) {
    if (msg.type === "progress" && "uuid" in msg && msg.uuid) {
      uuids.add(msg.uuid);
    }
  }
  return uuids;
}

/**
 * Walk from a tip to root, returning the count of conversation messages.
 * Only counts user/assistant messages, not progress or other internal types.
 * This ensures branch selection prefers actual conversation over progress updates.
 * Also handles compact_boundary nodes by following logicalParentUuid.
 */
function walkBranchLength(
  tipUuid: string,
  nodeMap: Map<string, DagNode>,
  progressUuids: Set<string>,
): number {
  let conversationCount = 0;
  let currentUuid: string | null = tipUuid;
  const visited = new Set<string>();

  while (currentUuid && !visited.has(currentUuid)) {
    visited.add(currentUuid);
    const node = nodeMap.get(currentUuid);
    if (!node) break;

    // Only count conversation messages for branch selection
    if (CONVERSATION_TYPES.has(node.raw.type)) {
      conversationCount++;
    }

    // Determine next node: use parentUuid, or logicalParentUuid for compact_boundary
    let nextUuid = node.parentUuid;
    const logicalParent = getLogicalParentUuid(node.raw);
    if (!nextUuid && logicalParent) {
      nextUuid = logicalParent;
    }

    // Fallback: if parent doesn't exist in the DAG, find previous node by file position.
    // This covers two cases:
    // 1. compact_boundary's logicalParentUuid references a message from a prior session
    // 2. Parent was a progress message (excluded from DAG)
    if (
      nextUuid &&
      !nodeMap.has(nextUuid) &&
      (logicalParent || progressUuids.has(nextUuid))
    ) {
      const fallback = findFallbackParentByLineIndex(
        node.lineIndex,
        nodeMap,
        visited,
      );
      currentUuid = fallback?.uuid ?? null;
    } else {
      currentUuid = nextUuid;
    }
  }

  return conversationCount;
}

/**
 * Find the node with the highest lineIndex below the given lineIndex.
 * Used as fallback when a compact_boundary's logicalParentUuid doesn't exist
 * in this session (e.g., references a message from a continued/parent session).
 */
function findFallbackParentByLineIndex(
  beforeLineIndex: number,
  nodeMap: Map<string, DagNode>,
  excludeUuids: Set<string>,
): DagNode | null {
  let best: DagNode | null = null;
  for (const node of nodeMap.values()) {
    if (node.lineIndex >= beforeLineIndex) continue;
    if (excludeUuids.has(node.uuid)) continue;
    if (!best || node.lineIndex > best.lineIndex) {
      best = node;
    }
  }
  return best;
}

/** Extract ISO timestamp string from a DagNode, or empty string if missing */
function getTipTimestamp(node: DagNode): string {
  return "timestamp" in node.raw && typeof node.raw.timestamp === "string"
    ? node.raw.timestamp
    : "";
}

/**
 * Build a DAG from raw JSONL messages and find the active conversation branch.
 *
 * Algorithm:
 * 1. Build maps: uuid → node, parentUuid → children
 * 2. Find tips: messages with no children
 * 3. Select active tip: longest branch wins (tiebreaker: latest lineIndex)
 * 4. Walk from tip to root via parentUuid chain
 * 5. Return active branch in conversation order (root to tip)
 *
 * Messages without uuid (like queue-operation, file-history-snapshot) are skipped.
 */
export function buildDag(messages: ClaudeSessionEntry[]): DagResult {
  const nodeMap = new Map<string, DagNode>();
  const childrenMap = new Map<string | null, string[]>();
  const progressUuids = collectProgressUuids(messages);

  // Build node map and children map
  for (let lineIndex = 0; lineIndex < messages.length; lineIndex++) {
    const raw = messages[lineIndex];
    if (!raw) continue;

    // Access uuid - only some entry types have it
    const uuid = "uuid" in raw ? raw.uuid : undefined;
    if (!uuid) continue; // Skip messages without uuid (internal types)

    // Skip progress messages - they form long chains that break branch selection
    if (raw.type === "progress") continue;

    // Access parentUuid - only some entry types have it
    const parentUuid = "parentUuid" in raw ? (raw.parentUuid ?? null) : null;

    const node: DagNode = {
      uuid,
      parentUuid,
      lineIndex,
      raw,
    };
    nodeMap.set(uuid, node);

    // Track children for each parent
    const children = childrenMap.get(parentUuid);
    if (children) {
      children.push(uuid);
    } else {
      childrenMap.set(parentUuid, [uuid]);
    }
  }

  // Find tips (nodes with no children) and calculate branch lengths
  const tipsWithLength: Array<{ node: DagNode; length: number }> = [];
  for (const node of nodeMap.values()) {
    const children = childrenMap.get(node.uuid);
    if (!children || children.length === 0) {
      const length = walkBranchLength(node.uuid, nodeMap, progressUuids);
      tipsWithLength.push({ node, length });
    }
  }

  // Select the "active" tip: most recent timestamp wins, tiebreaker is branch length.
  // Timestamp-first ensures post-compaction branches beat stale pre-compaction ones
  // even when compacted-away history makes the old branch appear longer.
  const selectedTip =
    tipsWithLength.length > 0
      ? tipsWithLength.reduce((best, current) => {
          const bestTs = getTipTimestamp(best.node);
          const currentTs = getTipTimestamp(current.node);
          if (currentTs > bestTs) return current;
          if (currentTs < bestTs) return best;
          // Same timestamp: prefer longer branch, then latest lineIndex
          if (current.length > best.length) return current;
          if (
            current.length === best.length &&
            current.node.lineIndex > best.node.lineIndex
          ) {
            return current;
          }
          return best;
        })
      : null;

  const tip = selectedTip?.node ?? null;
  const hasBranches = tipsWithLength.length > 1;

  // Build alternate branches info (all tips except the selected one)
  const alternateBranches: AlternateBranch[] = hasBranches
    ? tipsWithLength
        .filter((t) => t.node.uuid !== tip?.uuid)
        .map((t) => ({
          tipUuid: t.node.uuid,
          length: t.length,
          tipType: t.node.raw.type,
        }))
        .sort((a, b) => b.length - a.length) // Sort by length descending
    : [];

  // Walk from tip to root, collecting the active branch
  const activeBranch: DagNode[] = [];
  const activeBranchUuids = new Set<string>();
  const visited = new Set<string>(); // Cycle detection (defensive)

  let current: DagNode | null = tip;
  while (current && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    activeBranch.unshift(current); // Prepend to maintain root→tip order
    activeBranchUuids.add(current.uuid);

    // Determine next node: use parentUuid, or logicalParentUuid for compact_boundary
    let nextUuid = current.parentUuid;
    const logicalParent = getLogicalParentUuid(current.raw);
    if (!nextUuid && logicalParent) {
      // Follow the logical parent chain across the compaction boundary
      nextUuid = logicalParent;
    }

    let nextNode = nextUuid ? (nodeMap.get(nextUuid) ?? null) : null;

    // Fallback: parent doesn't exist in the DAG. Two cases:
    // 1. compact_boundary's logicalParentUuid references a message from a prior session
    // 2. Parent was a progress message (excluded from DAG)
    // Find the most recent node before this one in file order to bridge the gap.
    if (
      !nextNode &&
      nextUuid &&
      ((logicalParent && !nodeMap.has(logicalParent)) ||
        progressUuids.has(nextUuid))
    ) {
      nextNode = findFallbackParentByLineIndex(
        current.lineIndex,
        nodeMap,
        visited,
      );
    }

    current = nextNode;
  }

  return {
    activeBranch,
    activeBranchUuids,
    tip,
    hasBranches,
    alternateBranches,
  };
}

/**
 * Build a Set of all tool_result IDs from raw messages.
 *
 * This scans ALL messages (not just active branch) because parallel tool calls
 * can result in tool_results being on sibling branches. For example, when Claude
 * makes two parallel Read calls, the JSONL structure can be:
 *
 *   tool_use #1 (Read file A)
 *   ├── tool_use #2 (Read file B)
 *   │   └── tool_result for file B → continues to conversation tip
 *   └── tool_result for file A (sibling branch, no children)
 *
 * The tool_result for file A is valid but ends up on a "dead branch" because
 * the active path goes through tool_use #2. By collecting all tool_result IDs
 * from the entire file, we correctly identify that the tool_use was completed.
 */
export function collectAllToolResultIds(
  messages: ClaudeSessionEntry[],
): Set<string> {
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    const content = getMessageContent(msg);
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block === "string") continue;

      if (
        block.type === "tool_result" &&
        "tool_use_id" in block &&
        block.tool_use_id
      ) {
        toolResultIds.add(block.tool_use_id);
      }
    }
  }

  return toolResultIds;
}

/**
 * Find orphaned tool_use blocks on the active branch.
 *
 * A tool_use is orphaned if its ID doesn't have a matching tool_result
 * anywhere in the session. This happens when a process is killed while
 * waiting for tool approval or during tool execution.
 *
 * @param activeBranch - The active conversation branch (tool_uses to check)
 * @param allToolResultIds - Pre-built Set of all tool_result IDs from the entire session
 */
export function findOrphanedToolUses(
  activeBranch: DagNode[],
  allToolResultIds: Set<string>,
): Set<string> {
  const toolUseIds = new Set<string>();

  // Collect tool_use IDs from active branch
  for (const node of activeBranch) {
    const content = getMessageContent(node.raw);
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      // Skip string content blocks (can appear in user messages)
      if (typeof block === "string") continue;

      if (block.type === "tool_use" && "id" in block && block.id) {
        toolUseIds.add(block.id);
      }
    }
  }

  // Orphaned = tool_use without matching tool_result anywhere in session
  const orphaned = new Set<string>();
  for (const id of toolUseIds) {
    if (!allToolResultIds.has(id)) {
      orphaned.add(id);
    }
  }

  return orphaned;
}

/**
 * Sibling tool result info with the message and tool_use IDs it contains.
 */
export interface SiblingToolResult {
  /** The raw message containing the tool_result(s) */
  raw: ClaudeSessionEntry;
  /** Tool use IDs that this message has results for */
  toolUseIds: string[];
  /** UUID of the parent message (the tool_use message) */
  parentUuid: string;
}

/**
 * Find tool_result messages that are on sibling branches (not active branch).
 *
 * When Claude makes parallel tool calls, the JSONL structure can result in
 * tool_results being on sibling branches. For example:
 *
 *   tool_use #1 (Read file A)
 *   ├── tool_use #2 (Read file B)
 *   │   └── tool_result for file B → continues to conversation tip
 *   └── tool_result for file A (sibling branch, no children)
 *
 * This function finds those sibling tool_result messages so they can be
 * included in the output for the client to pair with their tool_uses.
 *
 * @param activeBranch - The active conversation branch
 * @param allMessages - All raw messages from the session
 * @returns Array of sibling tool_result messages with metadata
 */
export function findSiblingToolResults(
  activeBranch: DagNode[],
  allMessages: ClaudeSessionEntry[],
): SiblingToolResult[] {
  // Build set of UUIDs on the active branch
  const activeBranchUuids = new Set(activeBranch.map((node) => node.uuid));

  // Collect tool_use IDs from active branch
  const activeToolUseIds = new Set<string>();
  for (const node of activeBranch) {
    const content = getMessageContent(node.raw);
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (typeof block === "string") continue;
      if (block.type === "tool_use" && "id" in block && block.id) {
        activeToolUseIds.add(block.id);
      }
    }
  }

  // Find tool_result messages not on active branch that match active tool_uses
  const siblingResults: SiblingToolResult[] = [];

  for (const msg of allMessages) {
    // Skip messages on the active branch
    const uuid = "uuid" in msg ? msg.uuid : undefined;
    if (!uuid || activeBranchUuids.has(uuid)) continue;

    // Check if this message has tool_results
    const content = getMessageContent(msg);
    if (!Array.isArray(content)) continue;

    const matchingToolUseIds: string[] = [];
    for (const block of content) {
      if (typeof block === "string") continue;
      if (
        block.type === "tool_result" &&
        "tool_use_id" in block &&
        block.tool_use_id &&
        activeToolUseIds.has(block.tool_use_id)
      ) {
        matchingToolUseIds.push(block.tool_use_id);
      }
    }

    if (matchingToolUseIds.length > 0) {
      const parentUuid = "parentUuid" in msg ? (msg.parentUuid ?? "") : "";
      siblingResults.push({
        raw: msg,
        toolUseIds: matchingToolUseIds,
        parentUuid,
      });
    }
  }

  return siblingResults;
}

/** A complete sibling branch that contains tool_use/tool_result pairs */
export interface SiblingToolBranch {
  /** UUID of the node on active branch where this branch diverges */
  branchPoint: string;
  /** All nodes in this branch (including tool_use and tool_result messages) */
  nodes: DagNode[];
  /** Tool use IDs in this branch that have matching results */
  completedToolUseIds: string[];
}

/**
 * Find complete sibling tool branches - branches that diverge from the active branch
 * and contain completed tool_use/tool_result pairs.
 *
 * This handles the case where Claude spawns parallel Tasks as CHAINED messages:
 * Each Task is in a separate assistant message that chains from the previous.
 * When results come back, the conversation continues from one branch, leaving
 * other tasks on "dead" branches.
 *
 * Example structure:
 *   text-msg → task-1-msg → task-2-msg → task-3-msg → result-3
 *                  │              └──→ result-2
 *                  └──→ result-1 → continues... (ACTIVE BRANCH)
 *
 * In this case:
 * - Active branch: text-msg → task-1-msg → result-1 → continues
 * - Sibling branch: task-2-msg → task-3-msg → result-3 (with result-2 as sub-sibling)
 *
 * This function finds task-2-msg, task-3-msg, result-2, and result-3 as siblings.
 *
 * @param activeBranch - The active conversation branch
 * @param allMessages - All raw messages from the session
 * @returns Array of sibling branches with their nodes
 */
export function findSiblingToolBranches(
  activeBranch: DagNode[],
  allMessages: ClaudeSessionEntry[],
): SiblingToolBranch[] {
  if (activeBranch.length === 0) return [];

  // Build maps for quick lookup
  const activeBranchUuids = new Set(activeBranch.map((node) => node.uuid));

  // Build nodeMap and childrenMap from all messages
  const nodeMap = new Map<string, DagNode>();
  const childrenMap = new Map<string | null, string[]>();

  for (let lineIndex = 0; lineIndex < allMessages.length; lineIndex++) {
    const raw = allMessages[lineIndex];
    if (!raw) continue;

    const uuid = "uuid" in raw ? raw.uuid : undefined;
    if (!uuid) continue;

    const parentUuid = "parentUuid" in raw ? (raw.parentUuid ?? null) : null;

    const node: DagNode = { uuid, parentUuid, lineIndex, raw };
    nodeMap.set(uuid, node);

    const children = childrenMap.get(parentUuid) ?? [];
    children.push(uuid);
    childrenMap.set(parentUuid, children);
  }

  // Collect all tool_result IDs for checking if tool_uses are completed
  const allToolResultIds = collectAllToolResultIds(allMessages);

  // Find sibling branch starting points: children of active branch nodes that are not on active branch
  const siblingStarts: Array<{ branchPoint: string; startUuid: string }> = [];
  for (const node of activeBranch) {
    const children = childrenMap.get(node.uuid) ?? [];
    for (const childUuid of children) {
      if (!activeBranchUuids.has(childUuid)) {
        siblingStarts.push({ branchPoint: node.uuid, startUuid: childUuid });
      }
    }
  }

  // For each sibling start, walk the entire subtree and check for completed tool_uses
  const siblingBranches: SiblingToolBranch[] = [];

  for (const { branchPoint, startUuid } of siblingStarts) {
    // Collect all nodes in this subtree using BFS
    const subtreeNodes: DagNode[] = [];
    const queue = [startUuid];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const uuid = queue.shift();
      if (!uuid || visited.has(uuid)) continue;
      visited.add(uuid);

      const node = nodeMap.get(uuid);
      if (!node) continue;

      subtreeNodes.push(node);

      // Add children to queue
      const children = childrenMap.get(uuid) ?? [];
      for (const childUuid of children) {
        if (!visited.has(childUuid)) {
          queue.push(childUuid);
        }
      }
    }

    // Check if any tool_uses in this subtree have matching results
    const completedToolUseIds: string[] = [];
    for (const node of subtreeNodes) {
      const content = getMessageContent(node.raw);
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (typeof block === "string") continue;
        if (
          block.type === "tool_use" &&
          "id" in block &&
          block.id &&
          allToolResultIds.has(block.id)
        ) {
          completedToolUseIds.push(block.id);
        }
      }
    }

    // Only include branches that have at least one completed tool_use
    if (completedToolUseIds.length > 0) {
      // Sort nodes by lineIndex for consistent ordering
      subtreeNodes.sort((a, b) => a.lineIndex - b.lineIndex);
      siblingBranches.push({
        branchPoint,
        nodes: subtreeNodes,
        completedToolUseIds,
      });
    }
  }

  return siblingBranches;
}
