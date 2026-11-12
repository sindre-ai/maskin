# Wire a Stripe-style sender to Maskin

Stripe, and services that copy its format, sign every delivery with one header that
holds the timestamp and the signature: **t=1700000000,v1=5257a8...**. The generic
webhook extension checks this format with the **stripe** signature scheme. Nothing
here is specific to one vendor.

This scheme is set through the extensions API or the **create_extension** and
**update_extension** tools. The extension form in the app does not list it yet.

## The settings

| Setting | Value |
|---------|-------|
| signatureScheme | **stripe** |
| signatureHeader | **stripe-signature** |
| maxAgeSeconds | optional, **300** when left out |
| signing_secret | the endpoint's signing secret from the Stripe dashboard (**whsec_...**), used exactly as shown |
| eventMap | for Stripe: externalIdPath **$.id**, action path **$.type** |

There is no timestampHeader: the timestamp is inside the signature header.

## How Maskin checks a delivery

The signed text is the **t=** timestamp, a dot and the raw body. It is signed with
HMAC-SHA256 under the secret, and the header must hold that signature as hex in a
**v1=** entry. The header can carry several **v1=** entries (Stripe sends two while it
rolls a secret); one match is enough, and other keys such as **v0=** are ignored. A
delivery with a missing header, a missing **t=** or **v1=** part, a wrong secret, a
changed body or a timestamp more than **maxAgeSeconds** old is refused with a 401 and
nothing is written.

## Steps

1. In the Stripe dashboard add a webhook endpoint (any URL for now) and reveal its
   signing secret.
2. Create the extension with the settings above and the secret as **signing_secret**.
3. Copy the webhook URL from the response and set it as the endpoint URL in Stripe.
4. Send a test event from Stripe. It shows up under Recent deliveries on the
   extension page as Committed.

## Other vendors that sign with a plain base64 digest

For a vendor that signs the raw body with HMAC and writes the digest as base64
(Shopify is one), use **hmac-sha256** or **hmac-sha1** with **digestEncoding** set to
**base64**. The same option works on the **timestamp** scheme. Leaving it out keeps
hex, as before.
