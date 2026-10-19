# Wire Cal.com bookings to Maskin

Cal.com can push booking events into a workspace with no code change. You add a
custom extension, point a Cal.com webhook at it, and every new booking becomes
a **calcom.booking** event that triggers and agents can react to.

This page uses the same generic webhook extension as every other vendor. Nothing
here is specific to Cal.com on the Maskin side: it is the settings below, entered
in the extension form.

Cal.com's own reference for webhooks (payloads, triggers, signing):
https://cal.com/docs/developing/guides/automation/webhooks (checked against the
bring-your-own-integrations spec on 2026-09-28).

You need to be an owner or admin of the workspace, and the Extensions page
(Settings, Extensions) must be enabled for you.

## The settings at a glance

| Setting | Value |
|---------|-------|
| Signature scheme | HMAC-SHA256 raw body |
| Signature header | **x-cal-signature-256** |
| Signature prefix | none, leave it empty (Cal.com sends the bare hex digest) |
| Signing secret | any string you choose, 16 characters or more (use Generate) |
| External ID (dedup key) | **$.payload.uid** |
| Entity type | **calcom.booking** (Literal) |
| Action | **$.triggerEvent** (JSONPath), which resolves to BOOKING_CREATED or BOOKING_CANCELLED |

## Steps

### 1. Create the extension

1. Open Settings, Extensions and choose Add extension.
2. Name it **Cal.com** and choose Continue. You land on the extension page.

### 2. Generate and copy the signing secret

1. In the Incoming webhook section, leave "Start from a recipe" on Custom. There
   is no Cal.com recipe; the settings come from the table above.
2. Set Signature scheme to HMAC-SHA256 raw body and Signature header to
   **x-cal-signature-256**. Leave Signature prefix empty.
3. Next to Signing secret choose Generate one. The secret is shown once after you
   save, so you copy it in step 3.

### 3. Set the id and action paths, then save

1. In the Event mapping section set External ID to **$.payload.uid**.
2. Set Entity type to Literal and type **calcom.booking**.
3. Set Action to JSONPath and type **$.triggerEvent**.
4. Choose Save + generate URL. A one-time dialog shows the webhook URL and the
   signing secret. Copy both now. The secret is never shown again; you can only
   replace it.

The URL only exists after the first save, which is why the paths come before the
paste in Cal.com.

### 4. Paste the URL and secret into Cal.com

1. In Cal.com open Settings, Developer, Webhooks and create a new webhook.
2. Paste the Maskin URL as the Subscriber URL and the secret as the Secret.
3. Under the event triggers, tick Booking created and Booking cancelled.
4. Save the webhook in Cal.com.

### 5. Trigger on calcom.booking and verify with a test booking

1. In Maskin, create a trigger on entity type **calcom.booking** with action
   **BOOKING_CREATED** (or **BOOKING_CANCELLED** to react to cancellations) and
   attach the agent that should react.
2. Make a test booking on one of your Cal.com event types.
3. Back on the Maskin extension page the setup card changes from Waiting for first
   delivery to Receiving, and the delivery shows up under Recent deliveries as
   Committed. Your agent starts a session from the trigger.

If the card stays on Waiting, open the webhook in Cal.com and check its recent
requests. A 401 from Maskin means the secret in Cal.com does not match the one you
saved. A 404 means the URL is wrong or the token was regenerated.

## What a delivery looks like in Maskin

- Header: **x-cal-signature-256**, the HMAC-SHA256 of the raw request body in hex.
- Algorithm: HMAC-SHA256 over the raw body with your secret, no prefix.
- Id: **$.payload.uid**, the booking id. Maskin dedups on the id plus the action
  (for example **bk_7Hn2xQ:BOOKING_CANCELLED**), so Cal.com retrying the same event
  is acknowledged and ignored, while a cancellation after a creation for the same
  booking is a new delivery.
- Action: **$.triggerEvent**, for example BOOKING_CREATED.
- Entity type: **calcom.booking**.

## Seated event types are not supported

Every seat on a seated event type shares one booking id, so a second person booking the same slot is dropped as a duplicate.
