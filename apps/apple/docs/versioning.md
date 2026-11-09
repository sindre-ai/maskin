# Versioning the Apple apps

We follow semantic versioning 2.0.0 (semver.org): MAJOR.MINOR.PATCH, plus the build number as build metadata after a plus sign. The platform tags (v1.0.0 and later) follow the same scheme.

Two numbers, two owners.

## Version (what people see)

- Lives in one place: MARKETING_VERSION in project.yml. Every target reads it.
- Format: MAJOR.MINOR.PATCH. A missing patch means 0, so 1.1 is 1.1.0. The App Store shows the short form (1.1, 1.1.1, 1.2).
- MAJOR (1.x to 2.0): a change of what the app is, or a break that matters to users, such as dropping support for an iOS version or an incompatible change to stored data. A person decides. A redesign alone is not a major.
- MINOR (1.1 to 1.2): new user-visible features or improvements, nothing removed. The normal release.
- PATCH (1.1 to 1.1.1): a fix-only release, no new features.
- Raise a higher number and reset the ones below it (1.4.2 to 1.5.0, not 1.5.2).
- Versions only go up, and a version sent to Apple is never reused.
- Bumped by hand, in the first PR of the next release. Never bump it twice for one release.
- The App Store version, the What's New text and this number always match.

## Build number (what the machine sees)

- Set by CI, never by hand: a UTC timestamp, yymmddHHMM, on every upload (ios-testflight.yml).
- Always higher than the last upload, so it never needs coordinating.
- App Store Connect shows it next to the version, for example 1.1 (2611090245).
- In semver terms it is build metadata: it never changes which version is newer.

## Linking a build to its code

- After each successful upload CI tags the commit with the full semver and the build number: ios/v<MAJOR.MINOR.PATCH>+<build number>, for example ios/v1.1.0+2611090245.
- To find the code of any build in App Store Connect or a crash report, look up the tag with the same build number.
- The ios/ prefix keeps these apart from the platform tags (v1.0.0 and later), which cover the API and self-hosted runtime.

## Releasing

1. Merge the release's last change. CI builds and uploads.
2. Pick the newest build of that version in App Store Connect, attach it to the version, fill What's New, submit.
3. Record version, build number and commit tag on the release task.
4. After release, the next change that touches the app bumps MARKETING_VERSION: minor by default, patch if the next release is fix-only.
