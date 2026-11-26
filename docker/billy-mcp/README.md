# billy-mcp

Billy tool server for the accounting flow. Written fresh over Billy's official API (https://www.billy.dk/api/). No code from any community Billy server was read into it or copied.

Run: npm ci, npm run build, PORT=8080 npm start. Endpoint: POST /mcp (streamable HTTP, JSON). Health: GET /health.

Send the owner's access token as header X-Access-Token on every call. The owner makes it in Billy under Settings, Access tokens. In Maskin it is saved as a credential and referenced in the custom server's headers, so the agent never sees it. The server keeps nothing.

What it can do: check the connection, list and read organisation, accounts, contacts, tax rates and bills, save one bill as a draft, upload a receipt file and attach it to a bill. What it cannot do: approve, void, update, delete or pay anything, send invoices, or call any other address than api.billysbilling.com.

Live check status: not run against a real Billy company yet. The request shapes follow Billy's published docs and are covered by tests with a faked network, nothing more.
