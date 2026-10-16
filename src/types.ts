/** A tool as an MCP server describes it. Only the fields the protocol defines are kept. */
export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

/** One tool inside a snapshot: its definition and a fingerprint of everything in it. */
export interface SnapshotTool extends ToolDefinition {
  /** SHA-256 of the canonical form of the definition. Changes when anything in it changes. */
  hash: string;
  /**
   * Set when a source publishes more than one definition under the same tool name, for
   * example one per feature flag. The plain definition has no variant; the others are named.
   */
  variant?: string;
}

/** What a server offered at one moment. Two snapshots are what a comparison is made from. */
export interface Snapshot {
  /** Where the tool list came from: an endpoint URL, or a named source such as a release tag. */
  source: string;
  takenAt: string;
  server?: { name?: string; version?: string };
  tools: SnapshotTool[];
}

/** The vocabulary Stackduke uses for a tool's capability. */
export type CapabilityClass = "read" | "write" | "destructive" | "send" | "money";
export type CapabilityLabelSource = "mcp_annotation" | "heuristic" | "unclassified";

export interface CapabilityLabel {
  classes: CapabilityClass[];
  /** The tool takes a free-form or wildcard target, such as arbitrary SQL or a shell command. */
  broad?: boolean;
  source: CapabilityLabelSource;
  /** The words or annotations the label rests on, so a reader can check it. */
  basis: string[];
}

export type FindingSeverity = "high" | "medium" | "low";

/**
 * Something in a tool's text that a person should look at. A finding is a reason to review,
 * never a verdict: the rules are pattern checks and can be wrong in both directions.
 */
export interface Finding {
  rule: string;
  severity: FindingSeverity;
  /** Where the text was found, such as "description" or "inputSchema.properties.path.description". */
  where: string;
  /** What the rule looks for, in plain words. */
  reason: string;
  /** A short piece of the text, with invisible characters made visible. Never the whole text. */
  excerpt: string;
}
