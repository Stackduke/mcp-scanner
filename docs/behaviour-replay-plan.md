# Plan: behaviour replay for the pre-deploy check

Status: **plan only, not built, not approved.** Written 19 Oct 2026 for Dom's review, revised the same day to a general version for most teams. API details were checked in the providers' docs on that date and will drift.

## What it is for

The pre-deploy check (`check`, see the README's "Pre-deploy check") says *what* changed in an MCP server's tool definitions. It cannot say whether the change alters what an agent does with them. Teams that build agents on their own MCP servers want to know that before they merge: does the agent still call the tool, when, with what arguments, and does its final answer still rest on the right sources?

Behaviour replay answers that for one model, one system prompt and one set of cases. In CI it runs each case through the team's model twice, once with the approved tool definitions and once with the definitions the server lists now, several times each, and reports the difference. No tool is ever called: the model gets canned outputs the team wrote.

It is an add-on. It runs only when the check finds a tool change and the team has cases; with no change it makes no model calls and costs nothing.

## Which agents it fits, and which it does not

**It fits agents that run their own tool loop.** The team's code (or a framework it uses) calls the model, gets back tool calls, calls the MCP server itself, and sends the results back to the model. That covers agents built directly on a model API (Bedrock Converse, OpenAI Chat Completions or Responses with function tools, Anthropic Messages) and frameworks that list an MCP server's tools and hand them to the model as ordinary function tools. The replay stands in for that loop: it hands the model the same tool definitions and answers each call with a canned output instead of the server.

**Hosted MCP modes are out of scope.** Some providers can call an MCP server themselves: the model provider connects to the server, runs the tool and feeds the result to the model inside one API call (OpenAI's `mcp` tool type in the Responses API, Anthropic's MCP connector, and similar). There is no point at which a canned output can be put in, so the replay cannot test that path. A team on a hosted mode can still run the replay with the same definitions as function tools, but that tests a different path from production, and the report would say so.

## Where "before" and "after" come from

- **After**: the tools the server lists now. The check already gets these (`listTools` / `listToolsStdio` in `src/cli.ts`).
- **Before**: the lockfile **as it is on the base branch**, not in the working tree. Once the author runs `check --update` in the pull request, the working-tree lockfile equals the new tools and there would be nothing to compare. The Action reads it with `git show <base>:stackduke.lock.json`, which needs the base commit fetched (the default checkout is one commit deep). Locally, `replay --before=<git ref>` compares against any branch or commit.

**Exploratory servers.** A server still being built is a good fit: its tools change often, and a quick replay shows which change moved the agent. But there is no stable baseline yet. "Before" is just whatever the base branch holds, cases written against a tool that is later renamed or removed stop applying (the report lists them as "case no longer applies" rather than failing), and fail rules make little sense until the tools settle. For such a team the useful mode is the local command, run by a developer on demand, with CI and fail rules later.

## 1. Cases

JSON, one file per case under `stackduke-replay/cases/`, plus one settings file, `stackduke-replay/replay.json`. JSON because the scanner has no runtime dependencies, so no YAML parser; one file per case so a new case shows as its own diff. Read strictly, like the lockfile: an unknown field stops the run.

Settings:

```json
{
  "replayVersion": 1,
  "provider": "bedrock-converse",
  "model": "<model or inference profile id>",
  "region": "eu-west-1",
  "systemPromptFile": "agent/prompts/system.md",
  "inference": { "maxTokens": 2000, "temperature": 0.2 },
  "providerFields": {},
  "runsPerSide": 10,
  "maxSteps": 8,
  "maxModelCalls": 600,
  "sources": {
    "allow": ["*.gov", "docs.example.com"],
    "deny": ["contentfarm.example"]
  },
  "citations": "urls-in-text",
  "failWhen": []
}
```

`systemPromptFile` points at the agent's real prompt in the repository, so cases do not go stale when it changes. `inference` holds the settings every adapter understands; `providerFields` passes anything model-specific through unchanged (Bedrock's `additionalModelRequestFields`, for example). The replay must use the same model and settings as production, since a different model tells you about that model.

A case:

```json
{
  "name": "competitor-pricing",
  "about": "Asks for a current price. The agent should search and cite the vendor's own page.",
  "history": [],
  "user": "What does Acme charge for its team plan right now?",
  "outputs": {
    "web_search": {
      "default": {
        "results": [
          { "url": "https://acme.example/pricing", "title": "Acme pricing", "snippet": "Team: $24 per seat per month", "label": "reliable" },
          { "url": "https://pricewatch-blog.example/acme-2024", "title": "Acme prices (2024)", "snippet": "Team plan $19", "label": "unreliable" }
        ]
      }
    },
    "fetch_page": { "default": "Page not available." }
  },
  "expect": {
    "answerMustContain": ["24"],
    "answerMustNotContain": ["19"]
  }
}
```

- `history`: earlier turns, so a case can start mid-conversation.
- `outputs`: one canned output per tool, with optional `{ "when": { "argument": "value" }, "output": ... }` entries tried before `default`. A call with no canned output gets a fixed "no result" text and is reported as an **unscripted call**, since the model reaching for a tool nobody expected is itself a change.
- `label` on a search result is for the replay only and is **stripped before the model sees the output**, so it cannot steer the model.
- `expect`: simple text checks on the final answer, applied to both sides.

**First cases.** Five to ten requests where a changed tool should, or should not, be used. `replay init` writes a starter settings file and one empty case per tool in the lockfile. Teams with logs can import them instead (see Langfuse below).

## 2. The replay loop

For each case, for each side (before, after), for each of N runs:

1. Turn the side's tool definitions into the provider's format, through the adapter.
2. Send the system prompt, `history` and the user message.
3. For each tool call in the reply, record it (tool, parsed arguments, step, position), answer it with the canned output, and send again.
4. Stop when the model answers without a tool call, or at `maxSteps` turns ("ran out of steps" is recorded and reported).
5. `maxModelCalls` caps the whole job, so a description that sends the model into a loop cannot run up a bill.

Both sides run in the same job at the same time with the same model, so a provider quietly updating a model shows on both sides and does not look like a tool change.

### Adapters

One small interface: turn MCP definitions into the provider's tools, send a conversation, read back text, tool calls and token use, and append tool results. Each adapter is a few hundred lines over `fetch`, with no SDK.

**Ship first: AWS Bedrock Converse.** One tool-calling shape across the model families Bedrock serves (Anthropic Claude, Meta Llama, Mistral, Amazon Nova, OpenAI's models and others), as checked in AWS's API reference:

- Tools go in `toolConfig.tools[].toolSpec` with `name` (1 to 64 characters, `[a-zA-Z0-9_-]+`), `description`, `inputSchema` (the JSON Schema under `json`) and optional `strict`. `toolConfig.toolChoice` is `auto` (default), `any`, or `tool` (a named tool, only for Anthropic Claude 3 and Amazon Nova models).
- The reply has `stopReason: "tool_use"` and `toolUse` blocks in `output.message.content`, each with `toolUseId`, `name` and `input` (JSON).
- Results go back in a `user` message as `toolResult` blocks with the same `toolUseId` and `content` (a list of `json` or `text` items). `status: "error"` exists but is supported only by Amazon Nova and Anthropic Claude 3 and 4 models, so the adapter does not rely on it.
- `usage` gives `inputTokens`, `outputTokens` and cache counts, which feed the cost line.
- Not every model on Bedrock supports tool use; AWS keeps a feature table. The replay stops with a clear error on a model that refuses tools rather than reporting "never called".
- Tool names that break the 64-character `[a-zA-Z0-9_-]+` rule cannot be sent; the replay reports them instead of renaming them silently, since a renamed tool is a different tool to the model.
- Sign-in: a Bedrock API key sent as a bearer token is the simplest. Short-term AWS credentials (for example from GitHub's OIDC sign-in to AWS) need AWS Signature Version 4, which we would write with `node:crypto` (about a day) to keep the scanner free of runtime dependencies.

**Second: OpenAI-compatible Chat Completions.** The widest reach: OpenAI itself, Azure OpenAI, and many gateways and local servers speak it. Tools are `{ "type": "function", "function": { "name", "description", "parameters" } }`, calls come back as `tool_calls` with an `id`, results go back as `role: "tool"` messages with `tool_call_id`.

**Third: OpenAI Responses and Anthropic Messages direct.** Responses because OpenAI's guide says its newest models (GPT-6 Astra, GPT-6.1 Sol) need it for tool calling: `function_call` items with `call_id`, answered by `function_call_output`, with reasoning items passed back. Anthropic Messages for teams calling Claude directly: `tool_use` blocks answered by `tool_result` blocks with `tool_use_id`. Each is about a day once the interface exists.

Later, on demand: Google Gemini and others.

## 3. What is measured

Everything is reduced to **"the share of runs in which X happened"** on each side, so one statistical test covers all of it (section 4).

**How it got there: tool use.**

| Measure | Per run |
| --- | --- |
| Tool called | Called at least once. |
| Order | Which tool came first; the full sequence of tool names. |
| Arguments with fixed values (enums, numbers, booleans) | Each value seen, such as `recency` = `"week"`. |
| Arguments with free text (such as `query`) | Whether, after light normalising, the value matches any value seen on the before side. Which argument names appear, which catches renamed fields. |
| Odd calls | Unscripted calls; calls to a tool the after side no longer has; running out of steps. |

**What it said: the final answer and its sources.** Deterministic checks first, because they are cheap, exact and the same every time:

1. **Citations.** URLs are taken from the final answer (`"citations": "urls-in-text"`, which reads bare URLs and Markdown links). An agent that returns citations as structured data can name a JSON path instead. URLs are normalised: lower-case host, no `www.`, no trailing slash, no tracking parameters.
2. **Grounded or not.** Each cited URL is checked against the tool outputs **that run actually received**. A URL found there is *grounded*. A URL that appears in a canned output for a tool the model never called in that run, or nowhere at all, is *ungrounded*: the model cited something it did not see.
3. **Reliable or not.** Each cited URL is matched against the case's `label`s and the settings' `allow` and `deny` lists (domain patterns). A URL on neither list is *unlabelled*.
4. **Consulted, not only cited.** URLs passed to a page-fetching tool, or returned by a search tool, are recorded as *consulted*, so the report can say "fetched the blog page in 6 of 10 runs, cited it in 2".
5. **Answer text checks**: the case's `answerMustContain` and `answerMustNotContain`.

Per source and per category, the measures become rates: each URL's cite rate; the share of runs citing at least one unreliable or denied source; at least one ungrounded URL; no citation at all; at least one reliable source; each `expect` check passing.

**Optional: a model as judge.** For answer quality that patterns cannot see (does it answer the question, is it hedged sensibly), a case can carry a short `rubric`. A judge model, called through the same adapters with the team's key, gives each final answer a pass or fail against the rubric. Pass or fail, not a 1 to 10 score, so it fits the same rate test. Its limits, stated in the report every time it is used:

- The judge is a model too and varies from call to call. It judges both sides with the same rubric, without being told which side an answer came from, and `replay --calibrate` measures how often it disagrees with itself on the same answers.
- It adds one judge call per run, roughly 10 to 25 percent more cost depending on the judge model.
- It is advisory unless the team writes a fail rule on it.

## 4. Noise

Models vary from run to run, so the same tools can give 8 of 10 one day and 10 of 10 the next.

- A change is reported as **clear** only when Fisher's exact test, the standard test for comparing two rates on small samples, puts the chance of it being noise under 5 percent. Example: 10 of 10 runs before against 4 of 10 after gives about 1 percent, clear; 10 of 10 against 7 of 10 gives about 21 percent, shown as "possible change, not clear".
- Many measures are tested at once, so a few will look clear by chance. The report leads with the measures the team named in rules or `expect`, and marks the rest as "noticed" rather than "changed".
- A case showing a possible but unclear change is re-run, up to a ceiling such as 30 runs a side, before deciding. Money goes only where it is needed.
- `replay --calibrate` runs the approved tools against themselves. If that shows "changes", the cases or settings are too noisy to trust.
- Ten runs a side catches only large shifts. The report says so rather than implying it checked for small ones.

## 5. Report and fail rules

A section in the existing pull-request comment (same marker, updated in place), and a JSON file with every run kept as a job artifact. Sketch:

```markdown
### Behaviour replay: 2 clear changes

Replayed 6 cases, 10 runs a side, with the approved tools (base branch) and the tools listed now.
Bedrock Converse, <model id>. 120 runs, 412 model calls, 1.9M input and 0.24M output tokens.

- `competitor-pricing`: `web_search` called in 10 of 10 runs before, 4 of 10 after (clear).
  Cited at least one unreliable source in 0 of 10 before, 5 of 10 after (clear).
  Cited a URL it was never shown in 0 of 10 before, 2 of 10 after (not clear).
- 5 other cases: no clear change.

Ten runs a side detects large shifts only. This shows a tendency for this model, prompt and set of cases, not a guarantee.
```

The comment keeps the check's existing rules: every sentence is the scanner's; tool, argument and case names appear only as identifiers; and neither a server's descriptions nor the model's own text is quoted. Cited domains are the exception worth discussing: they are what a team most wants to see, and they come from the team's own canned outputs, so showing a domain (never a full URL or any answer text) is proposed. Full answers, arguments and URLs go in the JSON artifact, which stays in the team's CI.

With no `failWhen` rules the replay only reports. Rules a team can add once it trusts its cases:

- `{ "tool": "web_search", "callRateDropsByMoreThan": 30 }`
- `{ "unreliableCitationRateRisesByMoreThan": 20 }`
- `{ "ungroundedCitations": "fail" }`
- `{ "expect": "fail" }` (an `expect` check that passed before now fails)
- `{ "judge": "fail" }` (judge pass rate falls, clearly)

A rule fires only on a clear change bigger than its threshold. A failed rule fails the job as the check does (exit code 1). A model API error is exit code 4, "could not run", never a pass.

## 6. Keys, cost and what stays where

- **Keys**: the team's own, as CI secrets (a Bedrock API key or AWS credentials; an OpenAI or Anthropic key). Stackduke hosts nothing and never sees keys, cases or answers. The keys go only to the replay step, which never starts the server: the check step lists the tools into a file, and a separate step with the keys reads it. This keeps the existing rule that the server's program cannot reach CI secrets. On pull requests from forks GitHub passes no secrets, so the replay is skipped with a note.
- **Cost**: a job of 20 cases × 2 sides × 10 runs is 400 runs. At about 16,000 input and 2,000 output tokens a run (system prompt, tool definitions and canned outputs resent each turn, plus reasoning), that is about 6.4M input and 0.8M output tokens. At $2 and $10 per million (Claude Sonnet 5.5 direct from Anthropic, 19 Oct 2026) that is about $21; at $0.10 and $0.50 (Claude Haiku 5.5) about $1. Bedrock prices per model were not checked for this plan and should be read from AWS's pricing page. The report always shows real token counts, and the first real run should replace this estimate. Running only cases that involve a changed tool, and only when tools changed, keeps most pull requests at $0.

## 7. Langfuse: fit in, not compete

Many teams that want this already run evals in Langfuse (open source under MIT outside its `ee` folders, and self-hostable). Langfuse already does a lot of the surrounding work:

- **Datasets** of items with `input`, `expected_output` and `metadata`, which can link to the production trace they came from (`source_trace_id`), and can be built from traces in its UI.
- **Experiments** run from its SDK (`run_experiment` in Python, `runExperiment` in JavaScript), on a Langfuse dataset or on local data, with item-level and run-level evaluators whose results become **scores**, compared side by side in its UI. Its docs list running experiments in CI/CD.
- **Scores** can be posted directly (`POST /api/public/scores`, HTTP Basic auth with the project's public and secret keys, with `traceId`, `name`, `value`, `dataType`).

So the honest overlap is large: a team could write a Langfuse experiment whose task runs its agent twice with two tool lists. What Langfuse does not do is know about the MCP tool diff or the lockfile, supply a tool loop with canned outputs, run only when tools change, or say whether a difference is more than noise. The replay should bring those and hand the rest to Langfuse:

- **Import** (`replay import langfuse`): turn dataset items into cases (`input` becomes the user message and history), and, where an item links to a source trace, read that trace's tool observations (`GET /api/public/v2/observations` filtered by `traceId`; the v1 `/api/public/observations` on self-hosted v3) to fill the canned outputs. How tool calls appear in a trace depends on how the team instruments its agent, so the importer starts with one common layout, shows unmapped fields, and writes cases for a person to review before committing, since traces hold users' data.
- **Push back** (optional, off by default): post the replay's measures to the team's Langfuse as scores, tagged with the case, the side and the pull request, so they sit beside the team's other evals. Scores attach to traces, so each replay run would be written as a trace first. Whether replay runs can also appear as Langfuse experiment runs, which would give the side-by-side view for free, through the public API rather than its SDK, is to be confirmed when building. The data goes to the team's own Langfuse, not to Stackduke.

## 8. What it cannot promise

- It shows a **tendency for one model, one system prompt and one set of cases**. A pass means "no clear change on these cases", not "behaviour unchanged".
- Canned outputs are fixed, so later steps never react to real data. If what a tool *returns* changes, the replay sees it only when the team updates the canned outputs; a case can carry separate `outputsAfter` for that.
- Source checks are only as good as the labels and lists the team writes, and they see URLs, not whether a sentence is supported by its source.
- The judge is a model with its own noise and cost, and its pass or fail is an opinion.
- Small samples catch only large changes, and every extra run costs money.
- Hosted MCP modes are not covered (see the top).
- The author of a pull request controls the server, the cases and the rules, so like the check it makes changes visible; it does not stop someone who means harm.

## 9. Other tools

Checked in each tool's docs on 19 Oct 2026.

- **Langfuse**: see section 7.
- **promptfoo** (open source, runs in CI): `--repeat`, tool-call assertions (`is-valid-openai-tools-call`, `tool-call-f1` on tool names only, and `trajectory:` assertions that need tracing), tools from files, and MCP support that calls the real server. Its docs say its tool callbacks do not run the multi-turn loop that sends results back to the model.
- **LangSmith with `agentevals`**: trajectory match against a reference the team writes (`strict`, `unordered`, `subset`, `superset`), and an LLM-as-judge trajectory evaluator.
- **Braintrust** (hosted): scorers for tool use and a GitHub Action that comments on pull requests.
- **DeepEval** (open source): `ToolCorrectnessMetric` against expected tools, optionally in order.
- **OpenAI Evals**: being shut down (read-only from 31 Oct 2026, off on 30 Nov 2026).

**The edge**: all of these test an agent against expectations a team writes. Behaviour replay starts from the **MCP tool-definition diff in the pull request**: before and after come from the lockfile and the server, it runs only when tools change, it needs no expected trajectories, and it reports how behaviour *moved* with a noise test. A capable team could assemble something similar on promptfoo or Langfuse; ours is already wired to the lockfile and to starting the MCP server.

## 10. Effort

Rough working days, one person, including tests. Tests use a fake model server on 127.0.0.1 that returns scripted replies in each provider's format, so the suite never calls a real API and stays deterministic.

**Stage 1, the smallest general version worth showing (about 7 to 8 days):**

| Part | Days |
| --- | --- |
| Case and settings format, strict reader | 1 |
| Adapter interface and the replay loop (canned outputs, step limit, repeats, call cap, retries) | 1.5 |
| Bedrock Converse adapter, with API-key and Signature Version 4 sign-in | 1.5 |
| Tool-use measures and the rate test | 1.5 |
| Citation and source measures (grounded, labels, allow and deny) | 1 |
| `replay --before=<ref>` command and the Markdown report | 1 |

A local command only: no Action changes, no fail rules, no judge, no Langfuse, one provider. Shown on a small sample server with a `web_search` tool whose description we change, with mixed reliable and unreliable canned results, on our own Bedrock key (a few dollars at most). Presented as a prototype.

**Stage 2, ready for CI (about 5 to 6 days):** the Action step with the base-branch lockfile and a separate keyed step (1.5), fail rules (1), the JSON artifact (0.5), the Chat Completions adapter (1), `--calibrate` and re-running unclear cases (1), README and docs (0.5).

**Stage 3, on demand (about 7 to 8 days):** Langfuse import (2) and push (1.5), the model judge (2), the Responses adapter (1), the Anthropic Messages adapter (1).

**Later, not planned:** Google Gemini and other adapters, simulated multi-turn users, posting to GitLab merge requests, hosted MCP modes (not possible, see the top), and uploading results to a Stackduke dashboard.

Full version, stages 1 to 3: about 19 to 22 days.

## 11. Open questions

For the design partner:

1. How does the agent cite sources in its final answer: inline URLs, Markdown links, numbered footnotes, or structured data?
2. How are its traces put into Langfuse (Langfuse SDK, OpenTelemetry, a framework integration)? A trimmed sample trace would let us build the importer against the real layout.
3. Do they already have a list of trusted and untrusted domains, or would they rather label results case by case?
4. In CI, a Bedrock API key or short-term AWS credentials? Which model id and settings, including anything passed in `additionalModelRequestFields`?

For Dom:

5. Is showing cited domains in the pull-request comment acceptable (section 5), or should the comment carry counts only?
