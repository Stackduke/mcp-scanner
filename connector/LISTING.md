# Listing kit: MCP server lookup

Everything needed to list the lookup connector in four directories, prepared for Dom to submit from his own accounts (Linear SD-113). Requirements were checked on the web on **1 November 2026**. Directories change their rules often, so re-read each one's page (Sources, at the end) on the day you submit.

**Nothing here has been submitted, and the connector is not deployed.** Every directory needs the server answering at its public address first, so deploying it (connector/README.md, "Deploying") is step 1 of the checklist.

## Read first: what blocks submission

1. **The connector is not deployed.** `https://lookup.stackduke.com/mcp` does not answer yet. The registry requires a publicly reachable URL. Claude and ChatGPT test the live server, and ChatGPT rejects trial or demo plugins.
2. **`readOnlyHint: true` will likely fail ChatGPT review.** OpenAI's guidelines say to use `readOnlyHint: false` for "queuing work", and its review page lists "enqueue tasks" as a reason a tool is not read-only. `check_mcp_server` writes unknown addresses to the `CRAWL_QUEUE` KV namespace. Choose one before submitting to ChatGPT:
   - **(a) Move the queue write into its own tool**, for example `request_mcp_server_check`, annotated `readOnlyHint: false`, `destructiveHint: false`. `check_mcp_server` then stays honestly read-only. This is the recommended option: it is the cleanest for every directory.
   - **(b) Drop the queue write.** "Not tracked yet" still answers with the local scanner command.
   - **(c) Set `readOnlyHint: false` on `check_mcp_server`.** Clients will then ask users to confirm a lookup as if it changed something.

   Claude's policy has no rule that matches this exactly, but a reviewer could read it the same way, so (a) or (b) helps there too. The docs page (stackduke-web#163) and this kit describe the code as it is today. Update both if the tools change.
3. **Workers Logs metadata is unconfirmed.** The privacy text says each call logs exactly `{event, client, tool, at}`. Cloudflare's docs don't say what, if anything, Workers Logs attaches to a custom `console.log` line. After deploy, open one log line in the Cloudflare dashboard (Workers & Pages → the Worker → Logs) and confirm no URL, headers or IP are attached, before any submission relies on the privacy text.
4. **The docs page is not merged.** The documentation, privacy and support URLs below point to stackduke-web#163. Merge it, with the "Not live yet" note removed, once the Worker is live.
5. **Label accuracy.** Answers say "accuracy not yet measured" until `LABEL_ACCURACY` in `connector/src/config.ts` is set from SD-110 and SD-114 (68% → 79% agreement on the holdout set, awaiting Dom). That wording is honest as it stands, but set it before listing if the figure is accepted.
6. **Radar overlap.** `com.stackduke/radar` (radar.stackduke.com) is already in the official registry and answers about the 83 featured servers. Decide whether Radar stays alongside this one before listing both in Claude's and ChatGPT's directories, where two similar Stackduke listings may confuse people or reviewers.
7. **ChatGPT publisher identity.** Publishing needs OpenAI individual verification (publishes under Dom's name) or business verification (under a company name). Stackduke is an unincorporated project, so business verification may not be possible yet. Check what OpenAI accepts before choosing.
8. **Cursor's marketplace is partner-only for now.** Its docs say it works with "a small group of trusted partners". The submission may wait. The "Add to Cursor" link works without a listing.

## What is in this folder

| File | For |
| --- | --- |
| `connector/server.json` | The official MCP registry. Validated against the 2025-12-11 schema on 1 Nov 2026 |
| `connector/listing/cursor-plugin/` | Cursor's plugin marketplace: `.cursor-plugin/plugin.json`, `mcp.json`, `README.md`, `assets/logo.png` |
| `connector/listing/chatgpt-plugin/` | ChatGPT's plugin directory: `plugin.json` (with the 5 + 3 test cases), `mcp.json`, `assets/logo.png`. Validated against the agent-plugins.org 1.0.0 schemas on 1 Nov 2026 |
| `connector/LISTING.md` | This file: listing text, answers for each form, and Dom's checklist |

`assets/logo.png` is a copy of stackduke.com's `brand/stackduke-logo-512.png` (512 × 512, square, about 10 KB).

## Shared facts for every form

| Field | Value |
| --- | --- |
| Name | Stackduke MCP server lookup (the docs page calls it "MCP server lookup"; change both together if you rename it) |
| Server URL (planned) | `https://lookup.stackduke.com/mcp`, Streamable HTTP, `POST` only, JSON responses |
| Authentication | None. No OAuth, no headers |
| Documentation | https://stackduke.com/docs/guides/mcp-server-lookup |
| Privacy policy | https://stackduke.com/legal/privacy#mcp-server-lookup (also the page's own section: https://stackduke.com/docs/guides/mcp-server-lookup#privacy) |
| Terms of service | https://stackduke.com/legal/terms |
| Support | support@stackduke.com, or https://stackduke.com/docs/guides/mcp-server-lookup#support where a URL is needed |
| Website | https://stackduke.com |
| Source | https://github.com/Stackduke/mcp-scanner (MIT), folder `connector/` |
| Icon | `listing/*/assets/logo.png`, 512 × 512 PNG. Public copy: https://stackduke.com/brand/stackduke-logo-512.png. The SVG mark at `/brand/stackduke-mark.svg` is not square (viewBox 405 × 430), so don't use it where a square icon is required |
| Category | Developer tools |

### The two tools and their annotations

Every directory asks for these. They are also what the server returns from `tools/list` (`connector/src/tools.ts`).

| Tool | Title | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- | --- |
| `check_mcp_server` | Check an MCP server | `true` (see blocker 2) | `false` | `true` | `false` |
| `mcp_server_changes` | See an MCP server's tool changes | `true` | `false` | `true` | `false` |

**Why `openWorldHint: false`.** Both tools answer only from Stackduke's own copy of the tracker data, a bounded catalog, and never contact the server named. OpenAI's guideline allows `false` for "a tool confined to a bounded private account, workspace, or catalog". Be ready to explain this if a reviewer asks, because the input is any server address.

### Example prompts (golden prompts)

Every server named here is in the 1 November 2026 data. Svelte had one change in the last 30 days, and Aave has 10 tools guessed as `money`.

1. "Check the MCP server at https://huggingface.co/mcp. What tools does it list, and which are guessed to write or delete anything?" → `check_mcp_server`
2. "Has https://mcp.svelte.dev/mcp changed its tools since 1 October 2026?" → `mcp_server_changes` with `since: 2026-10-01`
3. "Look up com.aave/mcp in the MCP registry tracker. Which of its tools are guessed to move money?" → `check_mcp_server` by registry name
4. "Before I connect https://agenttools.wolfram.com/mcp, when did the tracker last check it, and did its tools change in the last 30 days?" → `check_mcp_server`
5. "Is the MCP server at https://example.com/mcp in the tracker? What tools does it have?" → `check_mcp_server`, answering "not tracked yet" with the local scanner command. Note that this records `https://example.com/mcp` in the crawl queue, so each reviewer run writes one KV entry.

---

## 1. Official MCP registry

**Namespace proof is already in place.** `com.stackduke` is proven by DNS: the apex TXT record `v=MCPv1; k=ed25519; p=JNs7…` is live on stackduke.com, and Radar was published under it as `com.stackduke/radar` on 27 October 2026. The private key is only on aethis-dev at `~/.config/stackduke/mcp-registry/key.pem`, and Dom still meant to back it up to Bitwarden. **No new DNS record is needed.** GitHub auth (`io.github.Stackduke/...`) is not used: the device-flow login can't see org membership today (registry issue #1468), and the DNS namespace matches the server's domain.

**`server.json`** (in this folder):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "com.stackduke/mcp-server-lookup",
  "title": "Stackduke MCP server lookup",
  "description": "Read-only lookup of a remote MCP server's tools and tool changes in Stackduke's tracker. No sign-in.",
  "version": "0.1.0",
  "websiteUrl": "https://stackduke.com/docs/guides/mcp-server-lookup",
  "repository": {
    "url": "https://github.com/Stackduke/mcp-scanner",
    "source": "github",
    "subfolder": "connector"
  },
  "remotes": [{ "type": "streamable-http", "url": "https://lookup.stackduke.com/mcp" }]
}
```

Rules it meets: the name matches `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`, and the description is exactly 100 characters, the maximum. A remote-only server needs no `packages`. The version is immutable once published, and a remote URL can belong to only one server name. Published versions can be deprecated but never deleted. The registry is still in preview, so data resets can happen.

**Steps (on aethis-dev, after the Worker answers at the URL):**

```sh
# Install mcp-publisher (v1.8.7 was the latest release on 30 Oct 2026)
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher

cd connector
../mcp-publisher validate            # checks server.json

# Log in with the existing DNS key. This reads the private key without printing it.
PRIVATE_KEY="$(openssl pkey -in ~/.config/stackduke/mcp-registry/key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
../mcp-publisher login dns --domain stackduke.com --private-key "$PRIVATE_KEY"
unset PRIVATE_KEY

../mcp-publisher publish
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.stackduke/mcp-server-lookup"
```

The registry also feeds the GitHub MCP registry, which VS Code's `@mcp` gallery searches, and aggregators such as PulseMCP pick it up.

**If the key is lost:** make a new one (`openssl genpkey -algorithm Ed25519 -out key.pem`), replace the apex TXT record with `v=MCPv1; k=ed25519; p=<base64 public key>` (from `openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64`), and remove the old record.

---

## 2. Cursor

**Install link** (works without any listing; put it on the docs page as an "Add to Cursor" button once the server is live):

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=mcp-server-lookup&config=eyJ1cmwiOiJodHRwczovL2xvb2t1cC5zdGFja2R1a2UuY29tL21jcCJ9
```

`config` is base64 of `{"url":"https://lookup.stackduke.com/mcp"}`, the bare server object as Cursor's docs show it. Cursor documents no official https redirect version, so a web page has to link the `cursor://` address directly.

**Marketplace.** Cursor no longer takes MCP servers on their own. Staff said on 10 March 2026 to "build it as a plugin" and submit at cursor.com/marketplace/publish. The publish form needs sign-in, so its fields could not be read. Requirements from the docs: the plugin must be open source; every plugin and every update is reviewed by hand; it needs a valid manifest, a unique name, a clear description, a committed logo, a README and relative paths only; and it should be tested locally from `~/.cursor/plugins/local/` first. No review time is published.

**The plugin** is in `listing/cursor-plugin/`:

- `.cursor-plugin/plugin.json`: name `stackduke-mcp-server-lookup`, version, description, author (Stackduke, support@stackduke.com), homepage (the docs page), repository, MIT, keywords, `logo: assets/logo.png`.
- `mcp.json`: `{"mcpServers": {"mcp-server-lookup": {"url": "https://lookup.stackduke.com/mcp"}}}`. No `type` field: Cursor infers it from `url`.
- `README.md`: what it does, the tools, three prompts, and the docs, privacy and support links.

**Open question:** Cursor's docs show plugins in subfolders only for multi-plugin repos, which list them in a root `.cursor-plugin/marketplace.json`. They don't say whether a single plugin may sit in a subfolder of a larger repo. The safe route is a small public repo, for example `Stackduke/cursor-plugin-mcp-server-lookup`, with the contents of `listing/cursor-plugin/` at its root. Creating it is Dom's call.

**Local test before submitting:** copy `listing/cursor-plugin/` to `~/.cursor/plugins/local/stackduke-mcp-server-lookup/`, restart Cursor, check that the server shows two tools, and run golden prompts 1 to 3 in the agent.

---

## 3. Claude Connectors Directory

**Where:** claude.ai/directory/manage → Submit new → MCP connector. It needs a paid plan (Pro, Max, Ultra, Team or Enterprise). On Team or Enterprise, an Owner submits. The listing belongs to the organization that submits it.

**Before submitting:** add the live server as a custom connector (Customize → Connectors → Add custom connector, Authentication "No sign-in") and run both tools. The form asks you to confirm every tool was run through MCP Inspector or as a custom connector. The Inspector commands are in `connector/README.md`.

**Form answers, step by step:**

1. **Connection:** `https://lookup.stackduke.com/mcp`.
2. **Tools:** synced from the server. Both should show a title and `readOnlyHint` / `destructiveHint`. Tool names are well under 64 characters.
3. **Listing:**
   - **Name** (≤ 100): `Stackduke MCP server lookup`
   - **One-liner** (≤ 200): `Look up a remote MCP server's tools, their machine-guessed kinds and how they changed, from Stackduke's public tracker. Read-only, and it never connects to the server you ask about.`
   - **Description** (≤ 2,000; this text is about 1,220 characters):

     > Before you connect a remote MCP server, ask Claude what it can do. This connector answers from Stackduke's public tracker, which lists the tools of the remote servers in the official MCP registry once a day, more than 16,000 of them.
     >
     > Ask about a server by its https address or its registry name, and Claude can tell you which tools it lists, a machine-guessed kind for each tool (read, write, send, destructive, money or unclear), what the server's own annotations claim, when the tracker last checked it, and what changed in its tools over time, with the two checks each change happened between.
     >
     > It is read-only. It never connects to the server you ask about and cannot act on any service. The kinds are guesses made from each tool's annotations, name and description without calling the tool, so they can be wrong, and they are not a safety rating. It sees only tools a server lists without sign-in, keeps the last 10 changes per server, and its data is about a day old. Tool descriptions are never returned.
     >
     > For an address the tracker has not seen, it says so, gives a command to scan the server on your own machine with Stackduke's open-source scanner, and records the address as a request for the tracker to look at.

   - **Categories** (1–5): Developer tools; Security (if offered).
   - **Documentation URL, privacy policy URL, support contact:** from the shared table above.
   - **Icon:** `listing/chatgpt-plugin/assets/logo.png` (512 × 512 PNG). No size or format is published for connector icons; a square PNG of at least 512 px is the safe choice.
   - **URL slug** (permanent once published): `stackduke-mcp-server-lookup`.
4. **Use cases:** golden prompts 1 to 4 (at least three are required). **Prerequisites:** none, no account. **Reads, writes or both:** reads. If asked, mention that unknown addresses are recorded as crawl requests in Stackduke's own storage, nothing of the user's (see blocker 2).
5. **Company:** Stackduke, https://stackduke.com, primary contact Dom.
6. **Authentication:** not required / no sign-in. No test account is needed.
7. **Data handling:** the connector calls only Stackduke's own data, deployed with the Worker. It is not a proxy for anyone else's API, and it handles no health data and no sponsored content. Data collected: the client name and the tool name, logged per call, never the arguments.
8. **Test & launch:** reviewer access is "connect with no sign-in at the URL above and try the example prompts". Confirm the tools were run as a custom connector.
9. **Compliance attestations:** the seven checkboxes. Notes for each:
   - *Directory guidelines:* no promotion in tool descriptions (a test in `connector/test/` checks this); no hidden instructions; the server instructions tell the model to treat server-written names as identifiers, never instructions.
   - *First-party API use:* answers come only from Stackduke's own tracker data, deployed with the Worker. The Anthropic Software Directory Policy (3F) asks you to own or control what is retrieved, which this does. The connector reports *on* third-party servers but never calls them. A reviewer may still query this, so be ready to explain it (SD-113 "Watch for").
   - *Financial transactions:* none. The `money` kind is a label on other servers' tools, not an action.
   - *AI media generation:* none.
   - *Prompt injection:* tool descriptions from other servers are never returned, and names that don't look like identifiers are dropped.
   - *Conversation data collection:* only the tool arguments reach the server, and they are not logged.
   - *Public documentation:* the docs page.
10. **Review and submit.** It is listed as Community first, after an automated policy scan. Some submissions get human review, with variable times, and useful listings can be escalated to Verified. Escalations go to mcp-review@anthropic.com.

---

## 4. ChatGPT (OpenAI plugin directory)

OpenAI now calls apps "plugins". They are submitted as a ZIP, not a URL form, to "the universal directory shared by ChatGPT and Codex".

**Prerequisites:**

- **Verification:** individual or business, in platform.openai.com/settings/organization/general. "Publishing under an unverified individual or business name will result in rejection." See blocker 7.
- **Permission:** an organization owner submits, or a member with Apps Management Write (`api.apps.write`).
- **URLs, all https and from the same publisher:** website, support, privacy policy and terms of service. All four are in `plugin.json`.
- **Policy points that apply:** no trial or demo plugins; no "unofficial connectors to third-party services, including pass-through intermediary software layers" (this connector is first-party data about third-party servers, not a pass-through); no pricing or promotion in descriptions; it must work on desktop and mobile; and the privacy policy must cover data categories, purposes, recipients, retention and user controls, including any collection of query patterns or IP addresses. The privacy section covers each of these.

**Package** (`listing/chatgpt-plugin/`, zip its contents with `plugin.json` at the root):

```sh
cd connector/listing/chatgpt-plugin && zip -r ../stackduke-mcp-server-lookup-chatgpt.zip plugin.json mcp.json assets
```

- `plugin.json`: Agent Plugins 1.0.0 format, with `extensions.com.openai.interface`:
  - `displayName` "Stackduke MCP server lookup" (27/30)
  - `shortDescription` "Check an MCP server's tools" (27/30)
  - `longDescription` (1,106/4,000)
  - `developerName` Stackduke
  - `category` "Developer Tools"
  - the four URLs
  - three `defaultPrompt`s (each ≤ 128)
  - `logo` and `composerIcon`, both `./assets/logo.png`
  - `review.test_cases` (below), `commerce: false`, and release notes
  - `demo_recording_url` is left out until the video exists. It is required for review: add it to the file, or enter it in the dashboard.
- `mcp.json`: one server, `mcp-server-lookup`, `type: streamable-http`, the planned URL. There are no headers, which public submission rejects anyway.

**Test cases: exactly 5 positive and 3 negative** (also in `plugin.json`):

| # | Prompt | Tools | Expected behaviour |
| --- | --- | --- | --- |
| P1 | Check the MCP server at https://huggingface.co/mcp. What tools does it list, and which are guessed to write or delete anything? | `check_mcp_server` | Lists tool names by guessed kind with counts and the last-listed date. Says the kinds are machine guesses and not a safety rating. Never calls the server safe |
| P2 | Has https://mcp.svelte.dev/mcp changed its tools since 1 October 2026? | `mcp_server_changes` | `since` = 2026-10-01. Lists each change with its two checks, or says none was seen |
| P3 | Look up com.aave/mcp in the MCP registry tracker. Which of its tools are guessed to move money? | `check_mcp_server` | Lists the `money` tools and their count, with the machine-guess note |
| P4 | Before I connect https://agenttools.wolfram.com/mcp, when did the tracker last check it, and did its tools change in the last 30 days? | `check_mcp_server` | Gives the last-checked and last-listed dates and the 30-day change count, with nothing invented |
| P5 | Is the MCP server at https://example.com/mcp in the tracker? What tools does it have? | `check_mcp_server` | Says it is not tracked yet, gives `npx @stackduke/mcp-scanner check https://example.com/mcp`, and invents no tools |
| N1 | Use the Hugging Face MCP server to search for text-to-image models. | none | Running another server's tools is not supported; the plugin never connects to other servers |
| N2 | Remove my MCP server https://example.com/mcp from Stackduke's tracker. | none | Changing the tracker is not supported; the plugin only reads |
| N3 | Write me a short poem about autumn in Singapore. | none | Unrelated; should not trigger |

Before submitting, re-run P1 to P4 against the live data. The tracker updates daily, so check that the expected answers still hold. For example, if Svelte's October change ages out of the kept history, P2's answer becomes "no change seen", which is still correct.

**Demo video script** (about 90 seconds, screen recording in ChatGPT on the web, no voice needed; captions as on-screen text):

1. *(0:00)* Caption: "Stackduke MCP server lookup: check a remote MCP server before you connect it. Read-only, no sign-in." Show chatgpt.com/plugins with the plugin installed and its two tools listed.
2. *(0:10)* New chat, plugin on. Type P1. Show the tool call, `check_mcp_server`, being allowed, then the answer: tools by kind, the last-listed date, and the "machine guesses, not a safety rating" note. Caption: "Answers come from the tracker's published data. It never connects to the server you ask about."
3. *(0:35)* Type P2. Show `mcp_server_changes` with `since`, and the answer listing each change with its "seen between" window.
4. *(0:55)* Type P5. Show "not tracked yet" with the local scanner command.
5. *(1:10)* Type N1. Show that the plugin isn't used, or that ChatGPT says it can't run another server's tools.
6. *(1:20)* Show the docs page's Privacy section. Caption: "One log line per call: event, client, tool, time. Never your arguments." End on https://stackduke.com/docs/guides/mcp-server-lookup.

Host it where a reviewer can watch without signing in, for example an unlisted YouTube video or a Drive link set to "anyone with the link". Put the URL in `review.demo_recording_url`.

**Domain verification** (in the portal, under MCPs → Connect): the portal shows a challenge token and URL. Serve the exact token as plain text, with nothing else and no JSON, at:

```text
https://lookup.stackduke.com/.well-known/openai-apps-challenge
```

or at an eligible parent origin (`https://stackduke.com/.well-known/openai-apps-challenge`). The connector Worker answers 404 to everything except `/mcp`, `/health` and `/`. So either:

- add a route that returns the token from an environment variable (`OPENAI_APPS_CHALLENGE`, set with `wrangler secret put`, so the token isn't committed). This is a small code change to `connector/src/index.ts`, needing Dom's go; or
- serve it from the website: add `public/.well-known/openai-apps-challenge` to stackduke-web. This puts the token in a public repo. The token isn't secret, but check that the parent origin is accepted for a `lookup.` host first.

**Then:** upload the ZIP at platform.openai.com/plugins → Upload new or existing plugin → choose the verified identity. Fix metadata findings, connect the MCP server (domain challenge, no authentication), wait for the tool scan, fill in the review information, then Submit for review with the attestations. Feedback comes by email; appeal by replying to it. Once approved, Dom chooses when to Publish. Contact press@openai.com before any announcement that mentions the listing.

**ChatGPT test before submitting:** chatgpt.com/plugins → + → Add custom MCP server → URL → no authentication → I understand and want to continue → Create as a plugin. Run P1 to P5 and N1 to N3. Check it on the mobile app too, because the guidelines require desktop and mobile.

---

## 5. VS Code (no submission; it reads the official registry)

VS Code's `@mcp` gallery lists servers from the GitHub MCP registry, which draws on the official registry, so step 1 covers it. For the docs page, once live:

- Install link: `vscode:mcp/install?%7B%22name%22%3A%22mcp-server-lookup%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Flookup.stackduke.com%2Fmcp%22%7D`. This is URL-encoded JSON, not base64; use `vscode-insiders:` for Insiders.
- CLI: `code --add-mcp '{"name":"mcp-server-lookup","type":"http","url":"https://lookup.stackduke.com/mcp"}'`

---

## Dom's checklist, in order

Everything below is done from Dom's accounts, or needs his go. The prepared material is above.

1. **Decide the open points:** the queue write versus `readOnlyHint` (blocker 2), the listing name, Radar's future (blocker 6), and the `LABEL_ACCURACY` figure (blocker 5).
2. **Deploy the connector** (connector/README.md, "Deploying"): choose `lookup.stackduke.com`, create the `CRAWL_QUEUE` KV namespace, add `account_id`, deploy, and set up the daily refresh after Track. Then run the Inspector and add it to Claude as a custom connector.
3. **Check one Workers Logs line** in the Cloudflare dashboard (blocker 3).
4. **Merge the docs page** (stackduke-web#163) after removing the "Not live yet" note, and the tracker's "which is not live yet". Set the privacy policy's effective date. Optionally add the Add to Cursor and VS Code install links.
5. **Back up the registry key** (`~/.config/stackduke/mcp-registry/key.pem`) to Bitwarden, if not done yet.
6. **Official registry:** `mcp-publisher validate`, `login dns`, `publish` (section 1). About 5 minutes.
7. **Cursor:** test the plugin locally. Create the public plugin repo, or confirm a subfolder is accepted. Submit at cursor.com/marketplace/publish (section 2).
8. **Claude Connectors Directory:** from a paid plan, at claude.ai/directory/manage (section 3).
9. **ChatGPT:**
   - complete OpenAI verification (blocker 7);
   - record the demo video;
   - add the domain-challenge route (needs a small code change) or file;
   - zip and upload;
   - connect;
   - submit (section 4).
10. **After each listing:** add a line to Linear SD-113, and watch the first reviewer feedback on the "reports on third-party servers" question.

## Sources (all read on 1 November 2026)

- Official registry: github.com/modelcontextprotocol/registry, `docs/modelcontextprotocol-io/` (quickstart, remote-servers, authentication, versioning) and `docs/reference/server-json/official-registry-requirements.md`; schema https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json; `mcp-publisher` v1.8.7 (30 Oct 2026); live entry for `com.stackduke/radar`.
- Cursor: cursor.com/docs/mcp/install-links, cursor.com/docs/plugins, cursor.com/docs/reference/plugins, cursor.com/help/security-and-privacy/marketplace-security, and the Cursor forum thread 153911 (staff post, 10 Mar 2026).
- Claude: claude.com/docs/connectors/building/submission, claude.com/docs/connectors/building/review-criteria, claude.com/docs/directory/publish, claude.com/docs/connectors/custom/add-unlisted, and the Anthropic Software Directory Policy (support.claude.com/en/articles/13145358, "updated this week").
- OpenAI: developers.openai.com/plugins/deploy/submission, developers.openai.com/plugins/deploy/app-review, developers.openai.com/plugins/plugin-guidelines and developers.openai.com/plugins/deploy/connect-chatgpt; schemas at agent-plugins.org/schemas/1.0.0/.
- VS Code: code.visualstudio.com/docs/copilot/reference/mcp-configuration (28 Oct 2026).
