# Screenshots and previews spec

Apple requires screenshots for App Store Connect → *Apps → Maskin → \[version\] → App Store → iOS App → \[version\] → iOS App Preview and Screenshots*. Getting the right sizes, from the right devices, showing the right frames, in the right order, is the single most common source of avoidable rejection ("Guideline 2.3.10 — screenshots inaccurate" or "one or more screenshot sizes are missing").

Follow this spec to the letter. Store the exported images under `apps/native/ios-appstore/assets/screenshots/` before uploading — that path stays git-ignored (screenshots are binary blobs and shouldn't bloat the tree), but the local layout keeps the runbook navigable.

---

## Required sizes and quantities

Apple's current (2026) minimum set for a universal iPhone + iPad app:

| Size class            | Reference device                   | Pixel size (portrait) | Min screenshots | Max screenshots |
| --------------------- | ---------------------------------- | --------------------- | --------------- | --------------- |
| 6.9" iPhone display   | iPhone 16 Pro Max                  | 1290 × 2796           | 3               | 10              |
| 6.5" iPhone display   | iPhone 11 Pro Max / iPhone 14 Plus | 1242 × 2688           | 3               | 10              |
| 13" iPad display      | iPad Pro (M4)                      | 2064 × 2752           | 3               | 10              |

Ship **five** per size — the App Store product page shows the first three "above the fold" on iPhone and up to five on iPad, so five gives Apple the strongest showcase without diluting the tap-through message.

Apple derives the older 6.7"/6.1"/12.9" sizes from the 6.9" and 13" originals when a user's device is at one of the older sizes. You do **not** need to upload separate assets for those.

If a submission is rejected for size, re-verify against Apple's current spec page: https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications — Apple bumps the reference devices roughly once a year and their doc is authoritative.

---

## The five frames (same story on every size class)

Order matters — App Store Connect shows them left-to-right in the order uploaded, and the first three on iPhone are what most users see.

1. **For You feed on iPhone** — the primary hero. Show the feed with three or four cards, one card with an unread indicator. Overlay copy: *Review agent-generated cards from anywhere*.
2. **Card detail with the action bar** — a card open with Approve / Dismiss / Comment surfaced. Overlay copy: *Approve, dismiss, or comment — instantly*.
3. **Push notification** — either a lockscreen shot with the notification banner, or the app opening on the correct card after a tap-through. Overlay copy: *Never miss a signal that needs you*.
4. **Bet detail** — a bet page scrolled to show title, DoD, and a couple of tasks. Overlay copy: *Steer bets from your pocket*.
5. **Task list** — the workspace task list scrolled to show the density is legible on mobile. Overlay copy: *Every task in one thumb reach*.

On iPad, use the same content but with the extra width visible — the point of the iPad shots is to prove the app isn't letterboxed. The most valuable iPad shot to lead with is the **For You feed** at full width alongside the sidebar.

---

## Overlay style

- Overlay copy is white, `SF Pro Display Semibold`, ~72pt on iPhone / ~96pt on iPad.
- Top-third of the frame, left-aligned.
- No status bar retouching — leave the real bar in place. Apple sometimes rejects composites where the status bar looks stitched on.
- No third-party logos in the frames (no "Sign in with Google" screenshot, no partner brand chrome).
- Background of the frame is the app itself — no marketing-style solid-colour backgrounds or device mockup renders. Apple accepts them but they read as marketing and rarely convert better.

If the copywriter chooses different wording, that's fine — the overlay copy field above is a starting draft, not a hard-coded string. What is hard-coded: the *frame content* (which surface, at what scroll depth, with what state) must match.

---

## Capture recipe

The five frames are identical across size classes. Capture once per device, keep the state consistent, and you are done.

### Prep (once)

1. Sign the demo account (`<demo-account-email>` from `app-review-notes.md`) into a workspace pre-populated with:
   - At least six For You cards (mix of unread + read).
   - Three bets, each with three or four tasks.
   - One card with an existing comment thread visible (for the card-detail shot).
2. Silence notifications on the capture device: *Settings → Focus → Do Not Disturb* → on. Otherwise a random notification lands in the middle of a capture and Apple rejects.
3. Set the clock to 9:41 AM (Apple's convention on stock marketing shots). On simulators this is automatic under *Xcode → Screenshot* mode; on physical devices use *Airplane mode → set time manually*.
4. Battery indicator: ensure the physical device is plugged in — the charging bolt is preferred over any specific percentage.

### Physical-device capture (preferred)

1. Install the App Store build (not TestFlight — TestFlight adds a betas ribbon that Apple rejects).
2. Navigate to the target frame.
3. Press *Side + Volume Up* to screenshot. iOS saves to Photos at the exact 1290×2796 (or 1242×2688) resolution required.
4. AirDrop the shots to the Mac running the design pass.

### Simulator fallback

Only use the simulator when the physical device isn't available (e.g., 6.5" iPhone or 13" iPad Pro not on hand).

1. `xcrun simctl list devices` — find the target device (e.g., *iPhone 14 Plus* for 6.5", *iPad Pro (M4) 13-inch* for 13").
2. `open -a Simulator`, boot the target device: *Simulator → File → Open Simulator → \[device]*.
3. Install the App Store build via `xcrun simctl install booted <path-to-.ipa>`.
4. `xcrun simctl status_bar booted override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 --cellularMode notSupported --batteryState charged --batteryLevel 100` to pin the status bar to Apple's marketing conventions.
5. Capture with `xcrun simctl io booted screenshot ~/Desktop/6.5-frame-1.png`. The output is at the simulator's native resolution — matches Apple's required pixel size exactly.

Simulator captures render *without* device-frame chrome (bezel, notch, etc.), which is what Apple wants — App Store Connect adds its own on the product page.

### Overlay pass

Import into Figma (or the design tool of choice). Apply the overlay copy on a duplicate top layer at the position/weight in *Overlay style* above. Export as PNG (24-bit, no alpha channel — Apple rejects transparent PNGs with "invalid image").

---

## App Preview (video)

Optional on first submission. Skip for `0.1.0` to keep the surface small — a bad preview video is worse than none. Re-visit on the second release once the surface is proven.

If a preview is added later:

- 15–30 seconds, portrait, 1080×1920 or the size-class-native resolution.
- No third-party audio (Apple rejects licensed music without explicit clearance).
- Captured from the physical device using QuickTime → *New Movie Recording* → source: connected iPhone.

---

## Naming and upload

Rename before upload so App Store Connect's screen doesn't become a guessing game:

```
6.9-inch/
  01-foryou-feed.png
  02-card-detail.png
  03-push-notification.png
  04-bet-detail.png
  05-task-list.png
6.5-inch/
  01-foryou-feed.png
  ...
13-inch/
  01-foryou-feed.png
  ...
```

Upload in order. Drag-reorder afterwards if the sequence needs a tweak — the file name isn't user-visible, only the display order is.
