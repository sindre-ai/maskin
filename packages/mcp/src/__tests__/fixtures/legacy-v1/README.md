# Legacy (SDK v1) /mcp transcripts

Recorded from the legacy server on main at 0ddf711, SDK @modelcontextprotocol/sdk 1.29.x, before the move to SDK v2.
Each file holds one request and the exact status, content-type and body the route sent back.

They were recorded with the real route, the real createMcpServer and the real SDK transport behind a node http server.
Only the Maskin API behind the tool handlers was stubbed (apps/dev/src/__tests__/mcp-legacy-harness.ts).
Recording twice gave byte-identical files.

Replayed by apps/dev/src/__tests__/routes/mcp-legacy-transcripts.test.ts.
The three tools-call error files are also the real v1 text the misfire classifier is tested on (mcp-error-classification-golden.test.ts).
The tools/list answer is pinned separately by ../tools-list.legacy.golden.json.

Do not re-record these from the swapped server.
They exist so the swap is measured against what v1 did.
A diff the swap causes is a decision for that PR to make and explain, by editing the fixture by hand.
