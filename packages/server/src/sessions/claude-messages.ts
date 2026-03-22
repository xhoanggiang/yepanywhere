import type { ClaudeSessionEntry } from "@yep-anywhere/shared";
import {
  buildDag,
  collectAllToolResultIds,
  findOrphanedToolUses,
  findSiblingToolBranches,
  findSiblingToolResults,
} from "./dag.js";

export interface VisibleClaudeEntriesResult {
  entries: ClaudeSessionEntry[];
  orphanedToolUses: Set<string>;
}

interface NormalizeClaudeEntriesOptions {
  includeOrphans?: boolean;
}

export function collectVisibleClaudeEntries(
  rawMessages: ClaudeSessionEntry[],
  options: NormalizeClaudeEntriesOptions = {},
): VisibleClaudeEntriesResult {
  const { includeOrphans = true } = options;
  const { activeBranch } = buildDag(rawMessages);
  const allToolResultIds = collectAllToolResultIds(rawMessages);
  const orphanedToolUses = includeOrphans
    ? findOrphanedToolUses(activeBranch, allToolResultIds)
    : new Set<string>();

  const lineIndexByUuid = new Map<string, number>();
  for (let lineIndex = 0; lineIndex < rawMessages.length; lineIndex++) {
    const raw = rawMessages[lineIndex];
    const uuid = raw && "uuid" in raw ? raw.uuid : undefined;
    if (uuid) {
      lineIndexByUuid.set(uuid, lineIndex);
    }
  }

  const extrasByParent = new Map<
    string,
    Array<{ lineIndex: number; raw: ClaudeSessionEntry }>
  >();

  const pushExtra = (
    parentUuid: string,
    raw: ClaudeSessionEntry,
    lineIndex: number,
  ) => {
    const existing = extrasByParent.get(parentUuid);
    const entry = { lineIndex, raw };
    if (existing) {
      existing.push(entry);
    } else {
      extrasByParent.set(parentUuid, [entry]);
    }
  };

  for (const sibling of findSiblingToolResults(activeBranch, rawMessages)) {
    const uuid = "uuid" in sibling.raw ? sibling.raw.uuid : undefined;
    pushExtra(
      sibling.parentUuid,
      sibling.raw,
      uuid ? (lineIndexByUuid.get(uuid) ?? Number.MAX_SAFE_INTEGER) : 0,
    );
  }

  for (const branch of findSiblingToolBranches(activeBranch, rawMessages)) {
    for (const node of branch.nodes) {
      pushExtra(branch.branchPoint, node.raw, node.lineIndex);
    }
  }

  for (const extras of extrasByParent.values()) {
    extras.sort((left, right) => left.lineIndex - right.lineIndex);
  }

  const entries: ClaudeSessionEntry[] = [];
  const includedUuids = new Set<string>();
  const pushUnique = (raw: ClaudeSessionEntry) => {
    const uuid = "uuid" in raw ? raw.uuid : undefined;
    if (uuid) {
      if (includedUuids.has(uuid)) return;
      includedUuids.add(uuid);
    }
    entries.push(raw);
  };

  for (const node of activeBranch) {
    pushUnique(node.raw);

    const extras = extrasByParent.get(node.uuid);
    if (!extras) continue;

    for (const extra of extras) {
      pushUnique(extra.raw);
    }
  }

  return { entries, orphanedToolUses };
}
