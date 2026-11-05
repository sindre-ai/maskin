# Subscribe an agent to a webhook extension

Once an owner has added a webhook extension for a service, any agent in the
workspace can wake on that service's deliveries. The agent creates an ordinary
event trigger on the entity type and action the extension writes. There is
nothing vendor-specific on the agent side.

This page uses a made-up service, Acme, that posts a JSON body when a call
ends. For a real service see the [Cal.com recipe](calcom/README.md), which is
the same flow.

## Who does what

| Step | Who | Why |
|------|-----|-----|
| Add the extension, set the event map, copy the signing secret | Workspace owner or admin | Adding a service stays an owner decision. The secret is shown once and is never returned again, not even to the owner. |
| Create the trigger that points at an agent | Any workspace member who is not a viewer, including an agent | A trigger is just a rule on events that already exist in the workspace. It can only target agents that are members of the workspace. |

An agent cannot add an extension, change its event map or read its secret.
Those calls are refused unless the caller's role is owner or admin.

## 1. Owner adds the extension

In Settings, Extensions, add a custom extension and fill in the incoming
webhook section. For Acme:

| Setting | Value |
|---------|-------|
| Signature scheme | HMAC-SHA256 raw body |
| Signature header | **x-acme-signature** |
| External ID (dedup key) | **$.call.id** |
| Entity type | **acme.call** (Literal) |
| Action | **ended** (Literal) |

Choose Save + generate URL, copy the URL and the secret into Acme, and send a
test delivery. The extension page changes from Waiting for first delivery to
Receiving.

Every verified delivery becomes one event in the workspace with the entity type
and action from the event map. Its data is the whole request body, or the part
of it the event map's data path points at.

## 2. Agent creates the trigger

The agent calls **create_trigger** (or the owner uses the Triggers page) with an
event config:

- **type**: **event**
- **config.entity_type**: **acme.call**
- **config.action**: **ended**
- **config.filter**: optional, see below
- **target_actor_id**: the agent that should wake
- **action_prompt**: what the agent should do with the delivery

Entity type and action must match the extension's event map exactly.

### Narrowing with a filter

**config.filter** is matched against the event data. Keys are dotted paths into
the delivery body and values are compared exactly. A list of values means any
of them. For example, to wake only for completed calls:

- **filter**: **{ "call.status": "completed" }**

A delivery where the path is missing, or has another value, does not start a
session.

## 3. What the agent sees

The session starts within seconds of the delivery being accepted. Its prompt is
the trigger's **action_prompt**, a blank line, then **Triggering event:**
followed by the event as JSON. The delivery is in the **data** field of that
JSON, so the agent can read **data.call.id** and **data.call.status** straight
from its prompt without another call. The same event can be read later with
**get_events**.

Example prompt tail for an Acme delivery:

- **Triggering event:** **{"workspace_id":"...","entity_type":"acme.call","action":"ended","data":{"call":{"id":"call_done","status":"completed","duration_seconds":42}}, ...}**

## Things to know

- A vendor retrying the same delivery is acknowledged and ignored. The dedup key
  is the external ID plus the action, so it does not start a second session.
- A bad signature, an unknown URL or a disabled extension returns an error and
  writes no event, so no agent wakes.
- A viewer cannot create triggers.

The end-to-end behaviour on this page is covered by
**apps/dev/src/__tests__/integration/subscribe-an-agent.test.ts**.
