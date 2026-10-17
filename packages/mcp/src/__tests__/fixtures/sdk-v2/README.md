# SDK v2 error transcripts

Recorded from a scratch server on @modelcontextprotocol/server 2.3.1 (ext-apps 2.0.3), Zod 3.25 behind a Standard Schema adapter prototype, on 17 Oct 2026.
Each file holds one request and the exact status, content-type and body the server sent back.
Files 01 to 04 are the legacy leg (2025-era JSON-RPC, answered by WebStandardStreamableHTTPServerTransport with enableJsonResponse true).
Files 05 to 08 are the modern leg (2026-07-28: envelope in params._meta plus MCP-Protocol-Version, Mcp-Method and Mcp-Name headers, answered by createMcpHandler).

The cases mirror ../legacy-v1/: a wrong-typed argument on list_workspaces (real input schema), an unrecognized key inside create_loop (real input schema, which has .strict() branches), a tool that is not registered, and a handler that throws (a scratch tool named explode, since no real tool throws on demand).
Recording twice gave byte-identical files.

What they show, in short:
- Bad argument: still an in-band tool result with isError true. The text starts with "Input validation error: Invalid arguments for tool list_workspaces: " and has NO "MCP error -32602" prefix. The issue list is one compact "path: message" line, not the Zod JSON dump v1 sent.
- Unrecognized key: same envelope, text "Input validation error: Invalid arguments for tool create_loop: steps.0.when: Unrecognized key(s) in object: 'not_a_field'". The Unrecognized key(s) wording survives; the Zod JSON dump and the code unrecognized_keys do not.
- Unknown tool: now a top-level JSON-RPC error, code -32602, message "Tool no_such_tool not found". v1 sent this as an in-band tool result with isError true and the "MCP error -32602: " prefix.
- Handler throw: in-band tool result with isError true and the bare error message.
- Modern results add resultType "complete" and a serverInfo entry under _meta. Errors carry neither.

These are the real v2 text for the error classifier work. They are not golden files for the production server: the production tool names, descriptions and adapter are not in play here.
Do not edit them by hand. Re-record from a v2 server if the SDK version moves.
