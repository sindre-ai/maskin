# economic-mcp

e-conomic tool server for the accounting flow: reads, plus two optional write tools that are off by default. See UPSTREAM.md for where it comes from.

Run: npm ci, npm run build, PORT=8080 npm start. Endpoint: POST /mcp (streamable HTTP, JSON). Health: GET /health.

Send the owner's tokens as headers on every call: X-AppSecretToken and X-AgreementGrantToken. In Maskin they are saved as credentials and referenced in the custom server's headers, so the agent never sees them. The server keeps nothing.

Try it with e-conomic's public demo agreement: both tokens set to demo.

## Draft save and receipt upload (off by default)

Two tools, listed only when the container runs with ECONOMIC_WRITES=on: economic_save_voucher_draft (one finance voucher saved in a journal) and economic_attach_receipt (one PDF, PNG, JPEG or GIF up to 4 MB, sent base64 encoded, added to a voucher). Both leave the entry in the journal, not booked. There is no tool that books, changes or deletes, and no generic request tool.

Turning writes on is a deploy change, not a setting an agent can reach. In Maskin each call also needs the owner's approval on the custom server entry. e-conomic's public demo agreement is read-only (it answers 403 "The license is read-only"), so these tools need an agreement that allows writes to be tried for real.
