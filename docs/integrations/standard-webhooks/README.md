# Wire a Standard Webhooks sender to Maskin

Standard Webhooks (https://www.standardwebhooks.com) is the signing format used by
Svix, Resend, Clerk and a growing list of other services. They sign with a shared
secret, write the signature as base64, and send three headers. The generic webhook
extension checks this format with the **standard-webhooks** signature scheme. Nothing
here is specific to one vendor: the settings below are the whole recipe.

This scheme is set through the extensions API or the **create_extension** and
**update_extension** tools. The extension form in the app does not list it yet.

## The settings

| Setting | Value |
|---------|-------|
| signatureScheme | **standard-webhooks** |
| signatureHeader | **webhook-signature** (Svix's own name is **svix-signature**) |
| idHeader | **webhook-id** (**svix-id**) |
| timestampHeader | **webhook-timestamp** (**svix-timestamp**) |
| maxAgeSeconds | optional, **300** when left out |
| signing_secret | the secret the vendor shows, for example **whsec_...** (the prefix is optional) |
| eventMap | where the dedup id, entity type and action sit in the body, as for any extension |

Use the header names your vendor documents. Resend and Clerk send the **svix-**
names; senders that follow the spec send the **webhook-** names.

## How Maskin checks a delivery

The signed text is the message id, a dot, the timestamp, a dot and the raw body. It
is signed with HMAC-SHA256 under the base64-decoded secret, and the header must hold
that signature as base64 in a **v1,** entry. The header can carry several entries
separated by spaces (the vendor does this while it rotates a secret); one match is
enough. A delivery with a missing header, a wrong secret, a changed body or a
timestamp more than **maxAgeSeconds** old is refused with a 401 and nothing is
written.

## Steps

1. In the vendor, create the webhook endpoint and copy its signing secret.
2. Create the extension with the settings above and the secret as **signing_secret**.
   Add the **eventMap** for the events you want.
3. Copy the webhook URL from the response and paste it as the endpoint URL in the
   vendor.
4. Send a test event from the vendor. It shows up under Recent deliveries on the
   extension page as Committed.

A 401 means the secret does not match or the header names are wrong. A 422 means the
**eventMap** paths found nothing in the body.
