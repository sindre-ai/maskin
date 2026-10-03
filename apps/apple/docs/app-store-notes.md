# App Store notes

## In-app account creation requires in-app account deletion (guideline 5.1.1(v))

The app can create an account (`POST /api/actors`, human signup). App Review guideline 5.1.1(v):
an app that supports account creation must let the user **initiate deletion of that account
from within the app**. A link to a website, or an email address, is not enough.

**Maskin's backend has no self-delete for humans.** `DELETE /api/actors/{id}` is agents-only
(`apps/dev/src/routes/actors.ts`: it returns 403 "Only agent actors can be deleted" for a human,
and it also requires a workspace membership header). There is no account-deletion route
anywhere else, and no forgot-password route either. So a store build that offers "Create account"
fails review as it stands.

### Options

**(a) Hide sign-up in store builds (what the app does today, behind a flag).**
The sign-up UI is gated by the Info.plist key `MaskinEnableSignUp` (Bool, default `true` when
the key is absent). Set it to `false` for the App Store build: the screen shows only "Sign in",
the mode switch and the Terms line disappear, and the model can never enter create-account mode.
People create accounts on the web, then sign in on the device. Reviewers need a demo account:
put its credentials in App Store Connect's review notes.

Ships fastest and needs no backend work. Cost: the iOS app can't onboard a new user on its own.

**(b) Add a backend self-delete, then ship sign-up.**
Needs a design decision first, because deleting a human touches shared data:

- **Owned workspaces.** A human can own workspaces with other members, agents, sessions and
  objects. Options: refuse until ownership is transferred or the workspace is deleted; delete
  workspaces the user solely owns (and cascade); or transfer to the longest-standing admin.
  Refusing silently is not allowed by the guideline, so the app must be able to say what blocks
  deletion and offer the path.
- **Authored content** (objects, comments, messages, events). Keep and anonymise
  ("Deleted user"), or delete. Audit events probably stay, anonymised.
- **Credentials and integrations** created by the actor (API keys, Claude subscription slots,
  integration connections, push tokens) must be revoked, not just orphaned.
- **Billing.** An active subscription or purchased credits must be cancelled or explicitly
  acknowledged before deletion.
- **Re-auth.** Deletion should require the password again, and the app must call it from a
  clearly labelled Settings row ("Delete account") with a confirmation that states what is lost.
- It needs an `Idempotency-Key`, an `events` row, and an integration test against real Postgres
  (`.claude/rules/verification.md`).

The native client then adds the Settings row, calls the route, signs out and wipes local caches
(the sign-out path already does the wipe).

### Recommendation

Ship the first store build with `MaskinEnableSignUp = false` (option a), and plan (b) as its own
backend task. Turn the flag on only once the deletion route and the Settings row exist.

### The line for `project.yml`

Add to the `Maskin` app target's `info.properties`:

```yaml
MaskinEnableSignUp: true   # set to false for the App Store build until account deletion exists
```

Optional, same place: `MaskinTermsURL` and `MaskinPrivacyURL` (https only). The create-account
screen shows "By creating an account you agree to the Terms and Privacy Policy" with whichever of
the two are set, and omits the line when neither is. Nothing in this repo or the marketing site
defines those URLs yet, so none are hard-coded. App Review also requires a privacy policy URL in
App Store Connect regardless.

## Not built, on purpose

- **Forgot password.** There is no reset endpoint in the backend or the web app, so the sign-in
  screen has no such link.
