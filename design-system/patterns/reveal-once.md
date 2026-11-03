# Reveal-once

Shows a value one time and never again. Use it when a screen has just created or accepted a secret the product will not display in full after the dialog closes.

First used by the custom extension webhook (apps/web/src/components/extensions/webhook-reveal-dialog.tsx), which shows the webhook URL and the signing secret after Save.

## When to use

- A secret was just generated or pasted and the server stores it encrypted and never returns it.
- The user has to copy the value somewhere else (a vendor dashboard) before continuing.

Do not use it for values the page can show again. The webhook URL is stored plain, so after the dialog closes the detail page shows it in full with a Copy button. Only the signing secret is "never shown again".

## Anatomy

1. Title that names the destination: "Paste these into {vendor}".
2. One labelled value box per value, each with its own Copy button (the shared CopyButton in components/ui/copy-button.tsx: 2s check confirmation, announces "Copied" to screen readers).
3. A warning strip (role="note") for the secret only: "You won't see the secret again after this dialog closes."
4. Footer: Copy both, and one primary button, "I've saved them in {vendor}".

## Behaviour

- Escape, clicking the scrim and the corner close button are all disabled. The primary button is the only way out, because losing the value by accident is the failure this pattern prevents.
- The value is held in component state only while the dialog is open. Closing the dialog drops it.
- If the value is no longer available (for example after regenerating a token, when the secret is not held anywhere), render the dialog without that row and without the warning.
- Mobile: the dialog becomes a full-height sheet with the Copy buttons full width under each value.

## Related

- MaskedSecret (components/ui/masked-secret.tsx) draws what the page shows after the dialog closes: a fixed mask when the server never returns the value, or first 6 characters, dots, last 4 when the page still holds it.
