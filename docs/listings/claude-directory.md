# Claude connector directory: listing pack

Everything the portal at https://claude.ai/directory/manage asks for, ready to paste. Submitting is a person's step (it is done in Maskin's name). Nothing here is secret: do not put credentials in the portal or in this file.

Requirements source: Anthropic's "Submit a connector to the directory", "Connector pre-submission checklist" and "Test your connector" pages, read 2026-11-22.

## Link tagging

Every link to maskin.io that a person can click in the listing text ends in `?utm_source=claude`, so signups from the directory can be counted (tag value `claude`, one lowercase name per marketplace). The server URL and the `.well-known` discovery addresses are machine endpoints and stay untagged. Do not submit before the signup-tagging task is merged and live.

## 1. Connection

- Server URL: https://maskin.io/mcp
- Users connect to one URL (no per-customer URLs).
- Full tool set (123 tools). A smaller set only if a reviewer objects.

## 2. Tools

Tools sync from the server. Every tool carries a title and annotations from `packages/mcp/src/annotations.ts`. Extension tools (registered as `<extension>_<tool>`) get a plain title from their name and the changes-data label by default.

Labels follow the checklist: every pure read carries `readOnlyHint: true`, and every tool that is not read-only carries `destructiveHint: true` (create, update, send, delete, stop alike), so Claude asks before any of them. `destructiveHint` is derived from the read-only set in `annotations.ts`, and `surface-pin.test.ts` pins it. No tool takes a `method` argument or mixes reads and writes. Tool names are at most 27 characters (limit 64).

## 3. Listing

- Server name (max 100): Maskin
- One-liner (max 200): Run a Maskin product discovery flow from Claude: customer signals become insights and shaped bets, linked and tracked in your workspace.
- Description (max 2,000):

  Start with one flow. The Maskin product discovery flow turns customer signal (interviews, tickets, reviews) into typed insights, then into shaped bets and tasks, on one graph your team and your agents share. A product lead can install it in their own workspace and run it the same day: https://maskin.io/marketplace/product-discovery/?utm_source=claude

  Connect Claude to your Maskin workspace and you can ask it to look up what is active or blocked, create or update bets, tasks and insights, comment on them, start agents on a task, read files and meeting notes, and manage triggers and flows. What Claude creates shows up in Maskin under your name, so your team sees it.

  Sign in with one click: Claude sends you to Maskin, you pick a workspace and approve. You can see every connected client under Settings in Maskin and remove it at any time.

  Maskin is open source (Apache 2.0) and can be self-hosted. This listing connects to Maskin Cloud: https://maskin.io/?utm_source=claude

- Categories (1 to 5): Productivity, Project management, Developer tools
- Documentation URL: https://maskin.io/docs/?utm_source=claude
- Privacy policy URL: https://maskin.io/privacy?utm_source=claude
- Terms: https://maskin.io/terms?utm_source=claude
- Support contact: ai@maskin.io (support page: https://maskin.io/support?utm_source=claude)
- Icon: `assets/logo.svg` in the repo (80x80 viewBox, vector), or `apps/web/public/icon-512.png` (512x512 PNG)
- URL slug: maskin (permanent once published)

## 4. Use cases

- Look up the state of a workspace from a Claude conversation (what is active, what is blocked).
- Turn a conversation into bets, tasks or insights, linked to each other.
- Start an agent on a task and read what it did.
- Before connecting, a person needs a Maskin account and a workspace (https://maskin.io/?utm_source=claude).
- The connector reads and writes data.

## 5. Company

- Company name: Maskin
- Website: https://maskin.io/?utm_source=claude
- Primary contact for review updates: ai@maskin.io

## 6. Authentication

- Required. OAuth 2.0 with PKCE (S256), Claude's client is accepted through its client ID metadata document. No dynamic client registration.
- Discovery: https://maskin.io/.well-known/oauth-protected-resource/mcp and https://maskin.io/.well-known/oauth-authorization-server
- The person approves on Maskin's own page and picks the workspace. Details: `docs/reference/mcp-oauth.md`.

## 7. Data handling

- The API is Maskin's own first-party API. The MCP server domain (maskin.io) is the service's own domain.
- No personal health data. No sponsored content.

## 8. Test and launch

- Add https://maskin.io/mcp as a custom connector in Claude, connect, and call each tool group from a conversation before submitting. The portal asks for this confirmation. Run by the submitting person.
- Do not put credentials in the portal. For Verified review a reviewer emails ai@maskin.io for test access. Reply with the reviewer account from the notes below.

## 9. Compliance: the seven acknowledgments

The portal words each one itself and all seven are required. The topics, with where Maskin stands:

1. Directory guidelines (Software Directory Terms and Policy): we comply.
2. First-party API usage: the server calls only Maskin's own API.
3. Financial transactions: no tool moves money or crypto.
4. AI media generation: no tool generates images, video or audio with an AI model. (`transcribe_file` turns speech into text; it creates no media.)
5. Prompt injection: tool descriptions say what a tool does and do not steer Claude. Content stored in a workspace is returned as data.
6. Conversation data collection: tools receive only the arguments the person's request needs. Nothing reads Claude's memory, chat history or user files.
7. Public documentation: https://maskin.io/docs/?utm_source=claude and https://maskin.io/docs/what-is-mcp-native/?utm_source=claude

## Reviewer notes

Paste into the notes field, or send when a reviewer asks for test access.

> Maskin is a workspace of bets, tasks and insights that agents and people work on together. The connector is https://maskin.io/mcp and uses OAuth: on Connect, Claude opens Maskin's approval page. Sign in with the reviewer account, pick the reviewer workspace, and approve.
>
> The account and its sample data are described in the email reply; credentials are not stored in the listing. Try these, in order:
> 1. "List the objects in my Maskin workspace." Runs `list_objects` (read-only).
> 2. "Create a task called 'Reviewer check' in Maskin." Runs `create_objects`. It appears in the workspace under the reviewer's name.
> 3. "Add a comment on that task saying hello." Runs `create_comment`.
> 4. "Delete that task." Runs `delete_object` (destructive, Claude asks first).
>
> Some tools need a workspace feature or an integration (for example desktop tools, Gmail, Resend). They return a plain message when it is not set up. The sandbox has none connected on purpose, so no tool reaches a third party.
> Support: ai@maskin.io

## Reviewer test account

Status: see the task. Credentials live in Maskin's keychain and are sent by email on request. Never commit them.
