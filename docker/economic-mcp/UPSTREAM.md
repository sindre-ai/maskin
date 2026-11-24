# Upstream and changes

Derived from https://github.com/available-dev/e-conomic-mcp, MIT, Copyright (c) 2026 Available A/S.

- Pinned commit: 164567c616b7a734954b0fe7b965a3d56297fadf (LICENSE read at this commit, MIT).
- Nothing from other e-conomic servers or any Billy server was copied.

## Kept from upstream (reworked)
- The REST client idea and paging (src/client.ts, from src/economicClient.ts).
- The resource list for list and get tools (src/tools.ts, from src/tools/typed.ts).

## Removed on purpose
- economic_request (any method, any address), economic_create_customer, economic_update_customer, economic_create_draft_invoice, economic_book_draft_invoice.
- Dynamic per-endpoint tools, the OpenAPI loader (it could fetch a URL), the CLI, the stored credentials file, the ECONOMIC_BASE_URL override.

## Added
- One fixed host (restapi.e-conomic.com), relative paths only, redirects refused. Reads are GET.
- economic_save_voucher_draft and economic_attach_receipt: two narrow writes (POST a voucher to a journal, POST one file to one voucher), listed only with ECONOMIC_WRITES=on. Not from upstream. Nothing books, changes or deletes.
- HTTP entry, stateless: the two tokens come from request headers (X-AppSecretToken, X-AgreementGrantToken) per call and are never stored or logged.
- economic_check_connection, which says what to fix.

## Gate
The two write tools stay off in production until the CTO records e-conomic's answer on headless use on the bet.
