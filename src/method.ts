/**
 * The version of the tracker's method: the rules that turn what a server sends into what the data says
 * (what each tool is counted as doing, how a check's outcome is coded, what counts as a change).
 * Every list file, change record and scan manifest the tracker writes carries it, so a reader can tell
 * which rules produced a label. docs/METHOD.md says what each version changed; a test keeps the two in step.
 *
 * Major: a field changes meaning or shape. Minor: a rule change that can move a tool to another kind, or
 * change what is recorded as a change. Patch: a fix that changes no kind and no change record.
 */
export const methodVersion = "1.1.0";
