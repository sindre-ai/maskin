# economic-mcp

Read-only e-conomic tool server for the accounting flow. See UPSTREAM.md for where it comes from.

Run: npm ci, npm run build, PORT=8080 npm start. Endpoint: POST /mcp (streamable HTTP, JSON). Health: GET /health.

Send the owner's tokens as headers on every call: X-AppSecretToken and X-AgreementGrantToken. In Maskin they are saved as credentials and referenced in the custom server's headers, so the agent never sees them. The server keeps nothing.

Try it with e-conomic's public demo agreement: both tokens set to demo.
