# Demo shots

Scripted product screenshots of the **Maskin Demo** workspace, for social posts. The job only
ever works inside that workspace (id checked in `config.ts` before any call), and everything
in it is invented demo data.

## Run

Needs the Maskin Demo account's login. In an agent session it arrives from the Keychain secrets
"Maskin Demo email" and "Maskin Demo password" (as `KEYCHAIN_BYO_APIKEY_MASKIN_DEMO_EMAIL` and
`KEYCHAIN_BYO_APIKEY_MASKIN_DEMO_PASSWORD`); share both with the agent that runs the job. Set
`DEMO_EMAIL` and `DEMO_PASSWORD` to override them. The values are never printed. `MASKIN_API_KEY`
is needed for the upload. Once per machine:
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
