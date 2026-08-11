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
- **On a device** (signed Xcode project, device connected):
  ```sh
  pnpm --filter @maskin/mobile dev:ios -- --target aarch64-apple-ios
  ```
- **Production bundle** — builds `apps/web` and compiles the app from `apps/web/dist`:
  ```sh
  VITE_API_BASE_URL=https://your-backend.example pnpm build:ios
  ```

`pnpm build:ios` at the repo root (`turbo build:ios`) builds the web dist first, then shells out to `tauri ios build`. For the on-device spike, point `VITE_API_BASE_URL` at a backend the phone can reach — this is what the env-driven `API_BASE` in `apps/web` is for. Xcode signing: open `src-tauri/gen/apple/Maskin.xcodeproj` once, select your team, and set a unique bundle identifier.

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