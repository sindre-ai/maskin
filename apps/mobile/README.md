# apps/mobile — Maskin iOS shell (Tauri 2)

A thin [Tauri 2](https://tauri.app) iOS wrapper around the existing `apps/web` frontend. It bundles `apps/web`'s production Vite build into a WKWebView app so Maskin runs on a physical iPhone with full feature parity — the SSE layer, login, and all UI ship unchanged from the web app.

This is the milestone-0 spike deliverable of the ["Maskin iOS app via Tauri 2 wrapper"](https://maskin.io/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/c4293deb-db74-421e-8d59-5b3a93f401cc) bet. Direction and rationale live in [`docs/design/ios-app.md`](../../docs/design/ios-app.md).

## Layout

```
apps/mobile/
  build.mjs            # lightweight build task — verifies the web dist the shell bundles
  src-tauri/
    Cargo.toml         # Rust crate (maskin-mobile / maskin_mobile_lib)
    tauri.conf.json    # frontendDist -> ../../web/dist; CSP disabled
    capabilities/      # default capability for the app webview
    icons/             # generated icon set (incl. iOS AppIcon)
    src/lib.rs         # Tauri app entry (mobile_entry_point)
```

## Non-macOS safety

`apps/mobile` defines **no `dev` script**, so `turbo dev` / `pnpm dev` never touch the Rust or Xcode toolchain on any machine. The root `pnpm build` runs `build.mjs`, which only confirms that `apps/web/dist` exists (turbo builds web first via the workspace dependency) — no Rust/Xcode needed. The heavy compile is the opt-in `build:ios` task below.

## macOS: run on a physical iPhone

Prerequisites (Mac only): Node ≥ 20, pnpm, [Rust toolchain](https://tauri.app/start/prerequisites/), Xcode with the iOS platform, and the iOS Rust targets:

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

One-time project generation (creates the native Xcode project under `src-tauri/gen/apple`; the `ios` subcommand only exists on macOS):

```sh
pnpm --filter @maskin/mobile ios:init
```

Then either:

- **Development** — starts the web dev server, then the app on the simulator:
  ```sh
  pnpm --filter @maskin/mobile dev:ios
  ```
- **On a device** (signed Xcode project, device connected, backend already running — see "Backend for a device run" below):
  ```sh
  MASKIN_DEV_EXTERNAL=1 pnpm --filter @maskin/mobile exec tauri ios dev "<Device Name>" --host <your-mac-lan-ip>
  ```
  `<Device Name>` is the name shown by `xcrun devicectl list devices` (e.g. `Nutty`). `--host` must be the Mac's LAN IP (`ipconfig getifaddr en0`) — without it the CLI tries `localhost`, which the phone can't reach. `MASKIN_DEV_EXTERNAL=1` makes Vite bind `0.0.0.0` (see `apps/web/vite.config.ts`) instead of `localhost`, which is required for the same reason. The `dev:ios` package script (`tauri ios dev --target aarch64-apple-ios`) is simulator-oriented — `--target` there selects a build target, not a device, so it won't prompt for or install to a physical device on its own; pass the device name and `--host` explicitly as above.
- **Production bundle** — builds `apps/web` and compiles the app from `apps/web/dist`:
  ```sh
  VITE_API_BASE_URL=https://your-backend.example pnpm build:ios
  ```

`pnpm build:ios` at the repo root (`turbo build:ios`) builds the web dist first, then shells out to `tauri ios build`. For the on-device spike, point `VITE_API_BASE_URL` at a backend the phone can reach — this is what the env-driven `API_BASE` in `apps/web` is for. Xcode signing: open `src-tauri/gen/apple/Maskin.xcodeproj` once, select your team, and set a unique bundle identifier.

### Backend for a device run

`tauri ios dev` only runs `beforeDevCommand` (`pnpm --filter @maskin/web dev`) for you — it does **not** start the API. Bring it up yourself first, and don't also run the root `pnpm dev`/`turbo dev` at the same time — that starts its own web dev server on :5173 and will collide with the one `tauri ios dev` spawns:

```sh
docker-compose up -d postgres seaweedfs
pnpm db:migrate
pnpm --filter @maskin/dev dev   # backend on :3000, in its own terminal/background job
```

The phone never talks to :3000 directly — Vite's dev proxy (`apps/web/vite.config.ts`) forwards `/api`/`/mcp` from the Vite server (on the Mac) to `localhost:3000` server-side, so the webview only ever calls the Vite origin. This sidesteps CORS entirely; no `CORS_ORIGIN` changes needed for device testing. It does mean **the phone and the Mac must be on the same Wi-Fi network** — the app loads over `http://<mac-lan-ip>:5173` from the phone's side.

### Troubleshooting

- **`ios:init` fails trying to install cocoapods via `gem` (needs sudo)** — install it with Homebrew first: `brew install cocoapods`. Re-run `ios:init` afterwards; it detects the existing install and skips straight to project generation.
- **`error: No Account for Team "<TEAM_ID>"` during `xcodebuild`** — the Xcode app itself needs the Apple ID signed in (Xcode → Settings → Accounts), separately from any codesigning certificate already sitting in the Keychain. A cert can exist for a team your signed-in account doesn't have access to (e.g. an old paid-team cert under the same email as your current free/personal account) — `xcodebuild` will still fail with this error in that case. Check which team(s) your signed-in account actually has with `defaults read com.apple.dt.Xcode IDEProvisioningTeams`, and make sure `DEVELOPMENT_TEAM` in the generated `src-tauri/gen/apple/*.xcodeproj/project.pbxproj` (or `APPLE_DEVELOPMENT_TEAM` env var before `ios:init`) matches one of those team IDs, not just any cert you happen to have.
- **Free/personal Apple ID team is fine for this** — `maskin-mobile_iOS.entitlements` is empty, so there's nothing here that needs a paid Apple Developer Program membership to run on your own device. The tradeoff: a personal-team development certificate expires after 7 days, so the installed app will need a rebuild/reinstall weekly during a spike.
- **`apps/dev` crashes on boot with `SyntaxError: ... does not provide an export named '<X>'`** — a workspace package's `dist/` (commonly `packages/shared`) is stale relative to its `src/`. Run `pnpm --filter @maskin/shared build` (or the relevant package) and restart; `tsx watch` picks up the rebuilt `dist/` automatically without needing to kill/restart it manually.

## API base URL contract

`apps/web/src/lib/constants.ts`:

```ts
export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api'
```

- **Web deploys** — unset, falls back to the relative `/api` (Vite dev proxy). Unchanged behavior.
- **iOS shell** — set `VITE_API_BASE_URL` to an absolute URL at build time; every `api`/SSE call in the app uses it.

The new env var is in `turbo.json` `globalPassThroughEnv` so it flows into every turbo task.

## Auth & SSE (nothing blocks them)

- `security.csp` is `null` in `tauri.conf.json` — no CSP header is injected, so the custom-header `GET /api/events` SSE fetch and the login flow work from the app origin.
- `viewport-fit=cover` in `apps/web/index.html` extends the webview under the iPhone notch/home indicator and disables input zoom; the Tauri side does not restrict the inner origin.

## Magic-link deep link (login)

The shell registers the `maskin://` custom URL scheme via the `tauri-plugin-deep-link` plugin (`tauri.conf.json` → `plugins.deep-link.mobile`, registered in `src-tauri/src/lib.rs`). A login link such as `maskin://auth#key=ank_...&actor_id=...` opens the app, and `apps/web/src/lib/ios-shell.ts` (`initIosDeepLink`, wired into `apps/web/src/main.tsx`) feeds that fragment into apps/web's existing `applyMagicLinkFragment` — reusing apps/web's auth code unchanged — then reloads so the session bootstraps. In a plain browser the module is inert (guarded by `isTauri()`), so web deploys are unaffected. Verify on device by opening the `maskin://` link on the iPhone and confirming the user lands authenticated without pasting the key.