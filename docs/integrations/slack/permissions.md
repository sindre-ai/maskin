# Slack app permissions: what Maskin does with each one

Written for Slack's Marketplace review form. Read from `manifest.yml` and from the
provider code in `apps/dev/src/lib/integrations/providers/slack/` at the commit that
added this page. Where the code does not match the manifest, the row says so, so the
form is never filled in with a claim the app cannot back up.

No message text is stored by this page or by the review prep. Maskin uses the
messages it can see to run the agents the customer set up in their own workspace
(read the channel, answer, post). Customers choose which agents, channels and
people take part.

## Bot token

| Scope | What Maskin does with it | Why it is needed |
|---|---|---|
| `chat:write` | Posts, edits and deletes the app's own messages (agent replies, approvals) | The core product: an agent answers in Slack |
| `chat:write.customize` | Sets the agent's name and icon on each post | Shows which agent spoke, not just "Maskin" |
| `channels:read`, `groups:read`, `im:read`, `mpim:read` | Looks up channel names and info so people pick "#general", not an id | Agent and trigger setup |
| `channels:join` | Joins a public channel when the customer asks an agent to work there | Agent can read and answer where it is asked |
| `channels:history`, `groups:history`, `im:history`, `mpim:history` | Reads recent messages and threads in conversations the bot is a member of, when an agent is asked to read a channel or thread. Bounded: up to 200 messages per call, bot must be a member | Agents need the thread and channel context to answer. Private channels need an invite |
| `im:write` | Opens a one-to-one DM between the bot and a person | Agent sends a person a private message |
| `users:read` | Lists Slack people for pickers and looks up a person (`users.info`) to link them to their Maskin account by matching email | Account linking and "who said it" |
| `users.profile:read` | Declared in the manifest and requested at install. No call in the code reads a profile at this commit | See "Declared but not used" below |
| `app_mentions:read` | Receives "@Maskin ..." and starts the agent | Entry point for most agent runs |
| `reactions:read`, `reactions:write` | Receives reaction events for triggers, and adds a reaction when an agent is asked to | Trigger on a reaction; agent can acknowledge work |
| `files:read` | Downloads files shared in a conversation the agent is working in | Agent reads an attached document. Without it Slack answers HTTP 403 |
| `links:read`, `links:write` | Shows a compact preview card when a Maskin object link is pasted | Link previews |
| `commands` | Receives the `/maskin workspace <name>` command that picks which Maskin workspace a Slack person is linked to | Account linking |
| `canvases:read`, `canvases:write` | Declared in the manifest. No Slack canvas tool is registered in the code at this commit | See "Declared but not used" below |
| `team:read` | Requested at install. No `team.info` call in the code at this commit (the workspace name comes from the install response) | See "Declared but not used" below |

## User token (asked at install, alongside the bot token)

The code asks for four user scopes: `search:read.public`, `search:read.private`,
`search:read.mpim`, `search:read.im`. Slack message search has no bot-token equivalent.
The user token is stored encrypted with the install. It is never used to post.

At this commit nothing in `apps/` or `packages/` reads the stored user token. The
search feature these scopes were requested for is not shipped. See "Declared but not
used".

## Events the app subscribes to

`app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`,
`reaction_added`, `reaction_removed`, `channel_created`, `channel_deleted`,
`channel_rename`, `member_joined_channel`, `member_left_channel`. These feed the
triggers a customer sets up (for example "when someone asks in #support").

## Declared but not used (flagged for the CTO and Sebastian)

Slack's reviewers compare each scope to a feature they can see. These rows will draw
questions, and changing them forces every install to reconnect, so this task does not
change them:

1. The manifest lists 27 user scopes. The code asks for 4. Chat write, history, canvases, `users:read.email`, `emoji:read`, `files:read`, `channels:write`, `groups:write`, `im:write`, `mpim:write`, and the read scopes are declared and never requested.
2. The 4 requested search scopes have no feature that reads the user token.
3. `canvases:read` and `canvases:write` (bot) have no tool in the code.
4. The code handles the `link_shared` event, the `/maskin` slash command and Block Kit button clicks (routes `/slack-commands`, `/slack-interactive`, `/slack-actions-account-link`). The manifest has interactivity off, no slash command entry, no `link_shared` event and no unfurl domains.
5. Account linking reads the email on a Slack person (`users.info`, bot token) to match a Maskin account. `users:read.email` is declared only under the user scopes, not the bot scopes, so with the bot token Slack normally omits the email. Check whether linking by email works in the live app before the form says it does.
6. `users.profile:read` and `team:read` (bot) are requested with no call in the code that needs them.

## Privacy and support pages

Privacy: https://maskin.io/privacy/ . Support: https://maskin.io/support/ . Both
answered HTTP 200 when checked on 23 Nov 2026. Whether they say what Slack's review
needs (what Slack data is stored, how long, how to delete it) is not checked here.
