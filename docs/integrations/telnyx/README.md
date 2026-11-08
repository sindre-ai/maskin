# Wire Telnyx webhooks to Maskin

Telnyx signs its webhooks with an Ed25519 key pair: it keeps the private key and
shows you the public key. You add a custom extension, paste that public key, point
a Telnyx webhook at the extension URL, and every verified delivery becomes an event
that triggers and agents can react to.

This page uses the same generic webhook extension as every other vendor. Nothing
here is specific to Telnyx on the Maskin side: it is the settings below, entered in
the extension form.

Telnyx's own references:

- Signing and headers: https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks
- Insight group deliveries (signed the same way as call events): https://developers.telnyx.com/docs/inference/ai-insights/insight-groups

You need to be an owner or admin of the workspace, and the Extensions page
(Settings, Extensions) must be enabled for you.

## Not yet tried against a real delivery

The Ed25519 check is covered by unit tests with a generated key pair. It has not
been tried against a real Telnyx delivery, so the first live call-ended webhook is
the real check. The insight mapping below follows the body shown on Telnyx's
Insight Groups page; it has not been seen on a real delivery either, so confirm the
paths with Dry run (below) before you rely on them.

## The settings at a glance

The signature settings are the same for every Telnyx delivery. Only the event
mapping depends on what Telnyx sends, so use the row that matches your webhook.

| Setting | Value |
|---------|-------|
| Signature scheme | Ed25519 public key, timestamp + body |
| Signature header | **telnyx-signature-ed25519** |
| Timestamp header | **telnyx-timestamp** |
| Signed text | **{timestamp}\|{body}** (the timestamp, a pipe, the raw body) |
| Vendor public key | the public key from your Telnyx portal (32 bytes, base64) |
| Entity type | **telnyx.event** (Literal), for both kinds of delivery |

Event mapping for call-ended insight deliveries (an insight group's webhook):

| Setting | Value |
|---------|-------|
| External ID (dedup key) | **$.payload.request_id** |
| Action | **$.event_type** (JSONPath), which is **conversation_insight_result**; the Literal **conversation_insight_result** works too |

Event mapping for standard call events (for example call.hangup):

| Setting | Value |
|---------|-------|
| External ID (dedup key) | **$.data.id** |
| Action | **$.data.event_type** (JSONPath), for example call.hangup |

Why two mappings: a call event nests everything under data. An insight delivery has
record_type **event** and event_type **conversation_insight_result** at the top
level, and the rest under payload (request_id, conversation_id, status **completed**
or **failed**, insight_group_id, results). With the call event paths, an insight
delivery has no external ID and no action, and Maskin refuses it with a 422. One
extension takes one mapping, so use a separate extension if you want both kinds of
delivery.

How Maskin checks a delivery: the signature is base64 and must verify, with your
public key, over the timestamp, a pipe and the raw body. This is the same for both
kinds of delivery. A delivery with a missing header, a wrong key, a changed body or
a timestamp more than 300 seconds old is refused with a 401 and nothing is written.
A public key that is not 32 bytes of base64 is refused when you save.

## Steps

### 1. Create the extension

1. Open Settings, Extensions and choose Add extension.
2. Name it **Telnyx** and choose Continue. You land on the extension page.

### 2. Enter the settings and the public key

1. In the Incoming webhook section, leave "Start from a recipe" on Custom. There is
   no Telnyx recipe; the settings come from the tables above.
2. Set Signature scheme to Ed25519 public key, timestamp + body. Fill in the
   signature header, timestamp header and signed text from the first table.
3. In Vendor public key paste the public key from the Telnyx portal. There is no
   Generate button for this scheme: the key comes from Telnyx.
4. In the Event mapping section set Entity type to Literal **telnyx.event**, then
   set External ID and Action from the table for your delivery:
   - Call-ended insight delivery: External ID **$.payload.request_id**, Action
     JSONPath **$.event_type**.
   - Standard call event: External ID **$.data.id**, Action JSONPath
     **$.data.event_type**.
5. Use Dry run with a sample delivery body to check the paths resolve. For a
   call-ended insight delivery, paste a body from Telnyx's webhook log.
6. Choose Save + generate URL and copy the webhook URL.

### 3. Point Telnyx at the URL

Paste the Maskin URL as the webhook URL on the Telnyx side (for call-ended insights,
the insight group's webhook), and save it there.

### 4. Trigger on telnyx.event and verify

1. In Maskin, create a trigger on entity type **telnyx.event** with the action you
   want (**conversation_insight_result** for an insight delivery, or for example
   **call.hangup** for a call event) and attach the agent that should react.
2. Make a test call.
3. On the Maskin extension page the delivery shows up under Recent deliveries as
   Committed, and your agent starts a session from the trigger.

If nothing arrives, open the webhook in Telnyx and check its recent requests. A 401
from Maskin means the public key does not match the key Telnyx signs with, or the
clock on the delivery is more than five minutes off. A 404 means the URL is wrong
or the token was regenerated. A 422 means the External ID or Action path found
nothing in the body: check that you used the mapping for the kind of delivery Telnyx
is sending.
