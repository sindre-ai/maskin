# Demo shots

Scripted product screenshots of the **Maskin Demo** workspace, for social posts. The job only
ever works inside that workspace (id checked in `config.ts` before any call), and everything
in it is invented demo data.

## Run

Needs `DEMO_EMAIL` and `DEMO_PASSWORD` (the Maskin Demo account, from the Keychain) in the
environment, and `MASKIN_API_KEY` for the upload. Once per machine:
`pnpm --filter @maskin/e2e exec playwright install chromium`.

```
pnpm --filter @maskin/e2e demo:seed                       # fill the demo workspace, safe to rerun
pnpm --filter @maskin/e2e demo:shots                      # all shots
pnpm --filter @maskin/e2e demo:shots approval-card        # one shot by name
pnpm --filter @maskin/e2e demo:shots chat --no-upload     # keep the PNG local only
```

Shots: `approval-card`, `for-you`, `task-board`, `chat`, `bet` (see `shots.ts`). To add one,
add an entry to `SHOTS`.

PNGs are written to `demo-shots/out/` and uploaded to the main workspace's files as
`demo-shot-<name>-<YYYY-MM-DD>.png`. A rerun on the same day replaces that day's file, a run on
another day adds a new one. The viewport (1440x900, scale 2) and the browser clock are fixed, so
shots look the same every week.
