# Stackduke MCP server lookup for Cursor

Ask Cursor's agent about a remote MCP server before you add it: which tools it lists, what kind of action each tool is guessed to take, and how its tools changed over time. The answers come from Stackduke's public tracker, which lists the tools of the remote servers in the official MCP registry once a day.

- Read-only. It never connects to the server you ask about, and it cannot change anything in your accounts.
- No sign-in, token or setting.
- Tool kinds (read, write, send, destructive, money, unclear) are machine guesses from each tool's annotations, name and description. They are not a safety rating.

## Tools

| Tool | What it answers |
| --- | --- |
| `check_mcp_server` | A server's tool names grouped by guessed kind, counts, its own annotation claims, when it was last checked, and changes in the last 30 days |
| `mcp_server_changes` | The changes the tracker kept for a server, newest first, each with the two checks it happened between |

Both are annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.

## Try it

- "Check the MCP server at https://huggingface.co/mcp. What tools does it list, and which are guessed to write or delete?"
- "Has https://mcp.svelte.dev/mcp changed its tools since 1 October 2026?"
- "Look up com.aave/mcp in the MCP registry tracker. Which of its tools are guessed to move money?"

## Docs, privacy and support

- Documentation: https://stackduke.com/docs/guides/mcp-server-lookup
- Privacy: https://stackduke.com/docs/guides/mcp-server-lookup#privacy (also in https://stackduke.com/legal/privacy#mcp-server-lookup). It logs one line per tool call: event, client name, tool and time, never the arguments.
- Support: support@stackduke.com
- Source: https://github.com/Stackduke/mcp-scanner/tree/main/connector
