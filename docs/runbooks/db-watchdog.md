# Database watchdog

The API process probes the database every 15 s with `SELECT 1` through the same pool requests use (3 s timeout; a probe that hangs counts as a failure). If every probe fails for 3 minutes in a row, it logs one error line, `DB watchdog: database unreachable, restarting the process` (fields: `failedForMs`, `inFlight`), starts the normal shutdown and exits with code 1 after at most 5 s, so the supervisor restarts it with a fresh pool. It never exits in the first 5 minutes after boot. Why it exists: on 9-10 Nov the app's pooled connections were dead while Postgres was idle, and the site stayed down for 7 h 43 min until a human redeployed.

- Tune: `DB_WATCHDOG_FAIL_AFTER_MS` (whole number, 30000 to 1800000, default 180000). Anything else falls back to the default.
- Disable: set `DB_WATCHDOG=off` and restart. It is also off in tests.
- Needs a restart policy: the `app` service in `docker-compose.prod.yml` and `docker-compose.staging.yml` has `restart: unless-stopped`. If Coolify manages restarts itself, confirm in Coolify that a crashed app container comes back.
- Crash-loop caveat: if the database is genuinely down, the process restarts every 3 to 8 minutes. That is expected and visible in the logs; search for the line above. Disable the watchdog if the loop itself is the problem.
