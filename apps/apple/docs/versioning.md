# Versioning the Apple apps

Two numbers, two owners.

## Version (what people see)

- Lives in one place: MARKETING_VERSION in project.yml. Every target reads it.
- Format: major.minor, or major.minor.patch for a hotfix. Examples: 1.1, 1.1.1, 1.2.
- Minor (1.1 to 1.2): a release with new user-visible features. The normal case.
- Patch (1.1 to 1.1.1): a fix-only release, no new features.
- Major (1.x to 2.0): a person decides, for a change of what the app is, not for a redesign.
- Bumped by hand, in the first PR of the next release. Never bump it twice for one release.
- The App Store version, the What's New text and this number always match.

## Build number (what the machine sees)

- Set by CI, never by hand: a UTC timestamp, yymmddHHMM, on every upload (ios-testflight.yml).
- Always higher than the last upload, so it never needs coordinating.
- App Store Connect shows it next to the version, for example 1.1 (2611090245).

## Linking a build to its code

- After each successful upload CI tags the commit: ios/v<version>+<build number>, for example ios/v1.1+2611090245.
- To find the code of any build in App Store Connect or a crash report, look up the tag with the same build number.
- The ios/ prefix keeps these apart from the platform tags (v1.0.0 and later), which follow semver for the API and self-hosted runtime.

## Releasing

1. Merge the release's last change. CI builds and uploads.
2. Pick the newest build of that version in App Store Connect, attach it to the version, fill What's New, submit.
3. Record version, build number and commit tag on the release task.
4. After release, the next change that touches the app bumps MARKETING_VERSION to the next minor.
