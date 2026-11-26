# The tracker's method, by version

The tracker (the daily `track` run and its `data` branch) turns what each MCP server sends into what the data says: what each tool is counted as doing, how a check's outcome is coded, and what counts as a change. Those rules are the method. Its version is `methodVersion` in [`src/method.ts`](../src/method.ts), and it is written into:

- every list file in `lists/` (`methodVersion`): the rules that gave each tool in it its kind;
- every change record in `endpoints.jsonl` and `feed.json` (`methodVersion`): the rules that recorded the change;
- every scan's `manifest.json` (`methodVersion`): the rules the scan ran with.

Files written before version 1.0.0 have no `methodVersion`. They were written by the rules in the scanner's history up to the commit that added this file.

A list file is rewritten only when the server's tools change, or when newer rules give one of them a different kind. A list file stamped with an older version therefore means the newer rules read that list the same way.

## Numbering

- **Major**: a field changes meaning or shape.
- **Minor**: a rule change that can move a tool to another kind, or change what is recorded as a change.
- **Patch**: a fix that changes no kind and no change record.

Every new version gets an entry below, in the same pull request that changes `methodVersion`.

## 1.0.0 (26 November 2026)

The first numbered version. It is the method as it stood when numbering began. Nothing about how tools are read changed with it.

- **Kinds.** Each tool is counted under the most serious thing its name, its own annotations or its description suggest it can do (`src/risk.ts`, `src/authority.ts`). That includes the label rules up to and including the false-alarm fixes of 26 November 2026.
- **Outcomes.** Each check is recorded as listed (`L`), sign-in required (`S`), not usable (`N`), unreachable (`U`) or no token (`T`).
- **Changes.** A change is a change in what the server sent: tool names, and a hash of each field (title, description, input schema, output schema, annotations). A change in the scanner's own reading of an unchanged list is not recorded as a change.
- **Manifests.** Each scan writes `manifest.json` with the full sha256 of every file it wrote, and the workflow signs it. See [verify-a-scan.md](verify-a-scan.md).
