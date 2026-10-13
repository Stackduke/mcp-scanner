import { canonical, toolKey } from "./snapshot.ts";
import type { Snapshot, SnapshotTool } from "./types.ts";

export type ChangedField = "title" | "description" | "inputSchema" | "outputSchema" | "annotations";
const fields: ChangedField[] = ["title", "description", "inputSchema", "outputSchema", "annotations"];

/** Whether a field appeared, disappeared, or was there both times with different content. */
export type FieldChange = "added" | "removed" | "altered";

export interface ToolChange {
  /** The tool name, with `#variant` when the definition is a named variant. */
  name: string;
  fields: ChangedField[];
  /** How each changed field changed. A field that only appeared is not a rewrite. */
  how: Partial<Record<ChangedField, FieldChange>>;
  before: SnapshotTool;
  after: SnapshotTool;
}

export interface SnapshotDiff {
  from: { source: string; takenAt: string; tools: number };
  to: { source: string; takenAt: string; tools: number };
  added: SnapshotTool[];
  /** Keys of added definitions whose tool name already existed: new variants, not new tools. */
  addedToExistingTools: string[];
  removed: SnapshotTool[];
  changed: ToolChange[];
  unchanged: number;
}

/**
 * What differs between two looks at a server. Tools are matched by name (and variant, when a
 * source publishes several definitions of one tool), which is how a client addresses them: a
 * renamed tool is one removed and one added.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): SnapshotDiff {
  const earlier = new Map(before.tools.map((tool) => [toolKey(tool), tool]));
  const later = new Map(after.tools.map((tool) => [toolKey(tool), tool]));

  const earlierNames = new Set(before.tools.map((tool) => tool.name));
  const added = after.tools.filter((tool) => !earlier.has(toolKey(tool)));
  const removed = before.tools.filter((tool) => !later.has(toolKey(tool)));
  const changed: ToolChange[] = [];
  let unchanged = 0;

  for (const tool of after.tools) {
    const previous = earlier.get(toolKey(tool));
    if (!previous) continue;
    if (previous.hash === tool.hash) { unchanged += 1; continue; }
    const differing = fields.filter((field) => canonical(previous[field]) !== canonical(tool[field]));
    const how: ToolChange["how"] = {};
    for (const field of differing) how[field] = previous[field] === undefined ? "added" : tool[field] === undefined ? "removed" : "altered";
    changed.push({ name: toolKey(tool), fields: differing, how, before: previous, after: tool });
  }

  return {
    from: { source: before.source, takenAt: before.takenAt, tools: before.tools.length },
    to: { source: after.source, takenAt: after.takenAt, tools: after.tools.length },
    added, addedToExistingTools: added.filter((tool) => earlierNames.has(tool.name)).map(toolKey), removed, changed, unchanged,
  };
}
