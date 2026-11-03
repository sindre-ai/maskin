# App Store notes

## Account creation and in-app account deletion (guideline 5.1.1(v))

The app can create an account (`POST /api/actors`, human signup). App Review guideline 5.1.1(v):
an app that supports account creation must let the user **initiate deletion of that account
from within the app**. A link to a website, or an email address, is not enough.

**Status: satisfied.** Settings › Account › **Delete account** deletes the signed-in person's
account from inside the app, so "Create account" is shown in every configuration, Release included
(`MASKIN_ENABLE_SIGNUP: "YES"` in `project.yml`; the Info.plist key `MaskinEnableSignUp` still
exists as a switch, default `true`, and `false` hides sign-up again if it is ever needed).

### What the deletion flow does

1. **Preview first** (`GET /api/account/deletion-preview`). Nothing is deleted yet.
2. **Blockers** are listed in plain words with the workspace name and what to do: hand ownership
   of a workspace other people use to one of them, or cancel a paid plan. No password field is
   offered until nothing blocks.
3. **Workspaces left** are listed with how many other people stay. **Workspaces only the person
   is in** are listed separately with a toggle, "Also delete these workspaces" (off by default;
   it sets `delete_sole_workspaces`). The footer says what each choice means.
4. **Password re-entry**, then a final destructive confirmation stating that the account, profile
   and keys are deleted, the person is signed out, and it cannot be undone (plus the workspaces
   that go with it if the toggle is on).
5. `POST /api/account/delete`. A wrong password (401) shows an error and keeps the person signed
   in. On success the app signs out through the one sign-out path (push token, Keychain
   credentials, queued writes, caches, recents, exports) and returns to the signed-out screen.

Settings › Setup › **Delete workspace** deletes the current workspace: preview, blockers (not the
billing owner, live plan), the workspace name typed back, then a final confirmation. Afterwards
the app switches to another workspace. If it was the person's last one, the confirmation says so
beforehand, and afterwards the app asks "You have no workspaces left. Delete your account too?"
(**Delete account** opens the same password flow; **Not now** leaves them on the no-workspaces
screen). That screen (also shown on a cold launch with no workspaces) offers **Create
workspace** (a name field and a primary button; the app switches to the new workspace), with
**Delete account** and **Sign out** as secondary actions.

### App Review notes (paste into App Store Connect)

> Account deletion: sign in, tap the profile button, open Settings, then **Delete account**
> (under Account). The screen shows what will happen, asks for the password, and confirms before
> deleting. Demo account: <email> / <password> (a throwaway account, safe to delete; please use
> "Create account" on the sign-in screen to make your own if you prefer).

Recording flow for the screen recording: Create account -> Settings -> Delete account -> read the
preview -> enter password -> Delete my account -> signed-out screen -> try to sign in with the
deleted credentials and see it refused.

Optional, same Info.plist place as before: `MaskinTermsURL` and `MaskinPrivacyURL` (https only).
The create-account screen shows "By creating an account you agree to the Terms and Privacy
Policy" with whichever of the two are set, and omits the line when neither is. Nothing in this
repo or the marketing site defines those URLs yet, so none are hard-coded. App Review also
requires a privacy policy URL in App Store Connect regardless.

## Not built, on purpose

- **Forgot password.** There is no reset endpoint in the backend or the web app, so the sign-in
  screen has no such link.
