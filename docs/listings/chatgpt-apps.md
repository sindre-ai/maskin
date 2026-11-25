# ChatGPT apps: listing pack

Everything OpenAI's app portal asks for, ready to paste. Submitting is a person's step (it is done in Maskin's name, after OpenAI verification). Nothing here is secret: do not put credentials or the proof token in this file.

Sources, read live on 2026-11-23: OpenAI's [Upload and submit your plugin](https://developers.openai.com/apps-sdk/deploy/submission), [Remote MCP server review requirements](https://developers.openai.com/plugins/deploy/app-review.md), [App submission guidelines](https://developers.openai.com/apps-sdk/app-submission-guidelines) and [Authentication](https://developers.openai.com/apps-sdk/build/auth). OpenAI now calls an app a "plugin" on some pages (shared with Codex), so portal labels may say either. Same pattern as `docs/listings/claude-directory.md`.

What I could not check from here: the portal itself (nobody has opened it), and a real ChatGPT sign-in against Maskin. Both are called out where they matter.

## 1. Before the portal opens

1. Sebastian completes OpenAI individual or business verification in the OpenAI organization settings. The submitter must be an organization owner or hold the Apps Management Write role.
2. In the portal, pick the verified organization and project, and choose the verified developer identity. That name is how the listing appears publicly (use the company name).
3. The portal issues the domain challenge token. Set it as `OPENAI_APPS_CHALLENGE` in production (section 5). Setting it is a separate step, not part of this pack.
4. A person creates the demo account (section 7). Not part of this pack.
5. A person records the demo video (section 8). Not part of this pack.

## 2. Connection

- Server URL: https://maskin.io/mcp (stable, public HTTPS, one URL for every customer).
- Only one MCP server per app can be connected. Maskin has one.
- The tool set is the same for every client: 123 tools, synced from the server. A smaller set only if a reviewer asks (same rule as the Claude listing).
- The domain challenge host is maskin.io, the same host as the server URL.
- The server address must be inside the first plugin ZIP: OpenAI says "If your plugin uses an MCP server, include it in the initial ZIP" and that adding one to a skills-only plugin later is not supported. The ZIP holds `plugin.json` at its root and `mcp.json` with `mcpServers.maskin` set to type `streamable-http` and url `https://maskin.io/mcp`, plus `skills/` and `assets/` if wanted, and no lifecycle hooks. Public plugins are published once to a directory shared by ChatGPT and Codex, so this one submission should also create the Codex entry (not confirmed until the portal opens). Setup for Codex without a listing: https://maskin.io/docs/connect-ai-tools/.

## 3. Listing fields

Limits are the ones on OpenAI's submission page.

- Display name (max 30): Maskin
- Short description, subtitle (max 30): Bets, tasks and agents
- Long description (max 4,000):

  Maskin is an open-source workspace where AI agents do the work and people set direction. Insights, bets and tasks live as connected objects, and agents and people work on the same ones.

  Connect ChatGPT to your Maskin workspace and you can ask it to look up what is going on, create or update bets, tasks and insights, comment on them, start agents on a task, read files and meeting notes, and manage triggers and flows. What ChatGPT creates shows up in Maskin under your name, so your team sees it.

  Sign in on Maskin's own page: ChatGPT sends you to Maskin, you pick a workspace and approve. You can see every connected client under Settings in Maskin and remove it at any time.

  Maskin is open source (Apache 2.0) and can be self-hosted. This listing connects to Maskin Cloud at maskin.io. You need a Maskin account and a workspace first (https://maskin.io).

- Developer name (max 80): Maskin
- Category: pick from the portal's dashboard list. Closest fit: Productivity, then Project management or Developer tools if offered. The portal list was not visible when this was written, so confirm it there.
- Capabilities (max 20): Look up workspace state, Create bets, Create tasks, Create insights, Comment on objects, Start agents on a task, Read files, Read meeting notes, Manage triggers and flows.
- Starter prompts (up to 3, max 128 characters each):
  1. What is active in my Maskin workspace right now?
  2. Create a Maskin task to review the launch checklist.
  3. Show me what my agents did on my latest task.
- Keywords (optional): workspace, tasks, project management, agents, bets, open source.
- Brand colors (optional): not set. Take them from `apps/web` styles if a person wants them.
- Website URL: https://maskin.io
- Support URL: https://maskin.io/support/ (support email: ai@maskin.io)
- Privacy policy URL: https://maskin.io/privacy/
- Terms of service URL: https://maskin.io/terms/
- Documentation: https://maskin.io/docs/ and https://maskin.io/docs/what-is-mcp-native/
- Repository URL (optional): https://github.com/sindre-ai/maskin
- License identifier (optional): Apache-2.0

Checked 2026-11-23: all four URLs answer 200. The versions without a trailing slash answer 308 to the slash version, so paste the ones above.

## 4. Logo

- Primary logo: `apps/web/public/icon-512.png` (512x512 PNG, square). Limits: PNG, JPEG, WebP or SVG, square, at least 48x48, at most 5 MB.
- Vector alternative: `assets/logo.svg` (80x80 viewBox).
- Composer icon: the portal lists it as required for Codex. Reuse the same file unless the portal asks for another size.
- Dark variants: optional. None exist today.

## 5. Authentication and domain proof

- Auth: OAuth 2.0 with PKCE (S256). The portal does not take API keys, Basic auth or custom headers, so the Cursor-style key setup does not apply here.
- Client registration method: Client ID Metadata Document (CIMD). Maskin advertises `client_id_metadata_document_supported: true` and has no dynamic client registration.
- Client id (no secret): https://chatgpt.com/oauth/client.json
- Fixed redirect URI: https://chatgpt.com/connector_platform_oauth_redirect (the stable one OpenAI documents for servers that return `iss` in the authorize response; Maskin does).
- Token endpoint auth method: none (public client with PKCE). ChatGPT's own document lists `private_key_jwt` as its default and `none` as supported. Maskin advertises only `none`, and that is what is pinned.
- Scope: `mcp`.
- Discovery (checked live 2026-11-23, both 200): https://maskin.io/.well-known/oauth-protected-resource/mcp and https://maskin.io/.well-known/oauth-authorization-server
- Consent: the person approves on Maskin's page (https://maskin.io/oauth/authorize) and picks a workspace. Connections are listed and removable in Settings.
- Details: `docs/reference/mcp-oauth.md`.

If the portal shows a callback-specific client id (`https://chatgpt.com/oauth/{callback_id}/client.json`) or redirect (`https://chatgpt.com/connector/oauth/{callback_id}`) instead of the fixed ones, Maskin turns it away, because only the pinned pair is accepted. That is a trust-boundary change and goes back to the CTO, as the bet already says.

Domain proof:

1. In the portal, copy the challenge token.
2. Set `OPENAI_APPS_CHALLENGE` to that token in production and redeploy (listed in `.env.example` and both compose files).
3. Check `curl https://maskin.io/.well-known/openai-apps-challenge`: it must return only the token as plain text (not JSON). Today it answers 404, which is correct while the variable is unset.
4. Run the portal's verify step.

## 6. Tools and annotations

Every platform tool carries a title and the four hints from `packages/mcp/src/annotations.ts`. Every tool that is not read-only carries `destructiveHint: true` (create, update, send, delete and stop alike), for all clients, and `surface-pin.test.ts` pins it. Extension tools (`<extension>_<tool>`) get a plain title and read-only false, destructive true.

The portal asks for a justification on each destructive tool: what is irreversible and under what conditions, including safeguards. Use these:

- delete_object, delete_file, delete_relationship, delete_trigger, delete_loop, delete_extension, delete_workspace_field, delete_workspace_skill, delete_agent: removes the item (and what hangs off it). No undo. Scoped to the connected workspace and the person's role; the client asks the person before it runs.
- stop_session, stop_chat_agent: ends a running agent run. The run cannot be resumed from where it stopped.
- disconnect_integration: removes a connected third-party account from the workspace; it must be reconnected by a person.
- desktop_run: runs any command in the workspace's own sandbox computer. Scoped to that sandbox, not the person's device.
- Create, update and send tools (every other write tool): changes data in the connected workspace. An update can overwrite a body or a field, and a send (gmail_send_email, resend_send_email, approve_object_draft, approve_draft_from_chat) cannot be recalled. Scoped to the connected workspace and the person's role; the client asks the person before it runs.
- Extension tools: marked destructive by default, because an unmarked tool is treated as a write.

## 7. Demo account notes

The portal asks for a dedicated account, login URL, workspace details and sign-in steps. The credentials go into the portal fields separately and never into this repo.

- Login URL: https://maskin.io/login. ChatGPT sends the reviewer to Maskin's approval page, which asks them to sign in first.
- It must work with no MFA, no email or SMS code, no magic link and no private network. Confirm this on the account before submitting: sign in from a clean browser outside our network.
- Make it a throwaway account in its own workspace named Reviewer sandbox, with sample data only: 2 active bets, 3 tasks in different statuses (one in progress), 1 insight, and 1 file. No real customer data.
- The sandbox has no Gmail, Resend or other integration connected, on purpose, so no tool reaches a third party.
- The account must hold the role that can create, update and delete objects.
- Exclude it from the bet's outside-connection counts (the bet names it when set up).
- Reply to the reviewer from ai@maskin.io. Never commit the password.

## 8. Demo video

The submission page requires an accessible recording URL that shows the test cases. Nobody has made it yet. Record the positive cases below in order, then paste the URL in the portal.

## 9. Test cases

OpenAI asks for 5 positive and 3 negative cases. Each has a description, the prompt, the expected tools and the expected visible result. Run them in ChatGPT against the demo account (or any throwaway account with the sample data in section 7) before submitting, and fix the expected results here to what you saw. The expected results below are what the tools are built to do. Nobody has run them in ChatGPT yet.

Positive cases

1. Find the workspace.
   - Prompt: Which Maskin workspaces do I have?
   - Tools: list_workspaces
   - Expected: the answer names Reviewer sandbox and nothing else invented. No ids or timestamps in the written answer.
2. Read what is active.
   - Prompt: Show me the active bets in my Maskin workspace.
   - Tools: list_objects (type bet, status active)
   - Expected: the 2 seeded active bets by title, no others, no tasks mixed in.
3. Search across objects.
   - Prompt: Search my Maskin workspace for onboarding and tell me what it links to.
   - Tools: search_objects, then list_relationships or traverse_graph
   - Expected: the seeded objects that mention onboarding, with their related objects named. If none exist, the answer says so plainly.
4. Create a task.
   - Prompt: Create a task in Maskin called "Reviewer check" with the description "Confirm the connector can write."
   - Tools: create_objects
   - Expected: one task called Reviewer check, status at its starting status, visible in the Maskin web app under the reviewer's name. Exactly one is created.
5. Update it.
   - Prompt: Set the Reviewer check task in Maskin to in progress.
   - Tools: update_objects (may call search_objects or get_objects first)
   - Expected: the same task now shows in progress in Maskin. No second task, no other object changed.

Negative cases

1. Unrelated question.
   - Prompt: What is the weather in Copenhagen tomorrow?
   - Expected: no Maskin tool is called. Why: nothing in the request is about a workspace.
2. Another service's job.
   - Prompt: Write a short poem about spring.
   - Expected: no Maskin tool is called and nothing is created. Why: the request needs no workspace data and should not create or change anything.
3. Send outside.
   - Prompt: Email all my customers that our prices went up today.
   - Expected: no email leaves Maskin. The reply says it cannot send it (the sandbox has no mail integration) or asks for a draft to be approved first. Why: sending in a person's name needs an approved draft and a connected mail account.

After the run, delete the Reviewer check task in Maskin so the next run starts clean.

## 10. What Maskin does not meet yet

For the CTO to decide before submission. Each is a point in OpenAI's published rules, with the reason and a suggested call. Items 1 and 2 are settled and kept for the record.

1. Settled: every write tool is marked destructive. OpenAI: destructiveHint true for "sending messages or transactions you can't undo", and "overwriting" counts too. The CTO decided that every tool that is not read-only carries `destructiveHint: true`, for all clients. That covers `gmail_send_email`, `resend_send_email`, `approve_object_draft`, `approve_draft_from_chat` and every `update_*` tool. It is one change in `annotations.ts` plus the tests that pin it (`surface-pin.test.ts`), shared with the Claude listing, so nothing more is needed for ChatGPT.
2. Settled: the global choice is made, not open. The cost is that ChatGPT asks the person before every write, including ordinary edits. That was accepted over marking tools one by one, because a per-tool split cannot be defended to a reviewer who says an update can overwrite.
3. Tool responses carry internal identifiers. OpenAI's privacy review asks that responses leave out PII, telemetry and internal identifiers (session, trace or request ids, timestamps, internal account ids, logs) and secrets. Maskin's responses carry object ids, timestamps and actor ids by design, and `get_session_logs`, `get_events` and `get_session_activity` return logs. Ids are needed to chain calls, so some stay. Suggest: audit realistic responses in ChatGPT as OpenAI says, then decide what to trim. Not done here.
4. Credential-handling tools. OpenAI: do not collect or process API keys, passwords or one-time codes. `request_keychain_credential`, `request_keychain_access` and `connect_integration` exist for people to supply a credential. In a Maskin chat the person enters it in a card and it never passes through the model. Outside a chat session `connect_integration` falls back to a link. I have not confirmed from ChatGPT that no credential is typed into ChatGPT. Suggest: confirm on a real run, and if unsure expect a reviewer question.
5. Tools that run commands and start agents. The 123-tool set includes `desktop_run` (any command in the workspace sandbox), `create_sub_chat` and `create_chat` (start an agent). All are marked, and `desktop_run` is destructive. OpenAI's wording on side effects: they must not be hidden, and each operation should be its own tool with a clear description. They are separate tools. The risk is a reviewer objecting to the size and power of the set. Same fallback as Claude: a smaller set only if asked.
6. Third-party reach. `add_mcp_server`, `connect_integration` and the integration tools reach outside accounts. OpenAI's rule that a tool must not tell the model to call another plugin: I read the annotation file, not all 123 descriptions or the extension tools. A description audit is not done. Suggest: run it before submitting.
7. Tracking disclosure. OpenAI forbids tracking or metadata collection (timestamps, IP addresses, query patterns) unless disclosed. The sign-in route sends product analytics events per client (documented in `docs/reference/mcp-oauth.md`). I did not read the privacy policy against this. Suggest: someone checks that https://maskin.io/privacy/ covers it.
8. Demo account without MFA. Not verified, the account does not exist yet (section 7).
9. Demo video. Required for the first review, not produced (section 8).
10. ChatGPT sign-in is untested live. The pin was read from OpenAI's published document on 2026-11-22 and the discovery documents answer 200 today. Nobody has completed a real ChatGPT sign-in. The bet already holds the first submission for that test.
11. Package format. OpenAI's pages describe a plugin ZIP with a manifest (`plugin.json`, `mcp.json`, hooks removed), and section 2 says what ours holds. Whether the portal asks for that ZIP for a hosted-server-only listing is unconfirmed until it opens. If it does, building the ZIP is a small follow-up task.

Not an issue on the points I checked: no ads, no sponsored content, no payments moved by any tool, the name Maskin is not a generic dictionary word, support contact and privacy and terms links exist, the server is public HTTPS on the same host as the domain proof.
