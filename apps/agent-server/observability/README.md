# Shipping agent-server logs off the box

agent-server writes one NDJSON object per line to stdout/stderr. On a deployed
host systemd captures that into journald, which is enough to answer most
questions with `journalctl` — but only while you are ssh'd into that specific
box, and only for as long as journald's retention window holds.

This directory contains the host-side config for shipping those lines to a log
backend instead. The example uses [Grafana Alloy](https://grafana.com/docs/alloy/latest/)
→ Loki, because that is what we run; nothing about the application assumes it.

## What the application guarantees

The contract the collector depends on — and the reason this stays
vendor-neutral — is just this:

- **NDJSON on stdout/stderr.** `src/lib/logger.ts` emits
  `{level, time, msg, ...ctx}`. `info`/`debug` go to stdout, `warn`/`error` to
  stderr. There is no log-shipping SDK in the application and no network call
  in the logging path.
- **Stable field names.** `time` is RFC3339. `source` identifies the
  subsystem — guest microVM console lines carry `source: 'msb-exec'` (see
  `src/lib/guest-log-stream.ts`).
- **Secrets are already redacted at the source.** Guest console output passes
  through `redactSecrets()` before it reaches the logger, precisely because
  these lines are expected to leave the box.

Any collector that can read journald and parse JSON will work. Swapping Loki
for something else means replacing the `loki.write` component in
`alloy.alloy`; no application change.

## Files

| File | Purpose |
|------|---------|
| `alloy.alloy` | The collector pipeline. Commit-safe — every deployment-specific value is read from the environment. |
| `alloy.env.example` | The values you must supply, with guidance on where to find each. |

## Setup

### 1. Install Alloy on the agent-server host

Follow Grafana's [install instructions](https://grafana.com/docs/alloy/latest/set-up/install/)
for your distribution. On Debian/Ubuntu this installs an `alloy` systemd unit
reading `/etc/alloy/config.alloy` with environment from `/etc/default/alloy`.

`alloy.alloy` targets **Alloy 1.x**. It uses `sys.env()`, which the older
Grafana Agent (Flow mode / River) spelled `env()`; if you are pinned to that,
rename those calls. Structured metadata additionally requires **Loki 3.0+** —
on an older Loki, move `session_id` and `stream` from `stage.structured_metadata`
into the log line rather than promoting them to labels.

### 2. Configure

```sh
cp apps/agent-server/observability/alloy.alloy      /etc/alloy/config.alloy
cp apps/agent-server/observability/alloy.env.example /etc/default/alloy
$EDITOR /etc/default/alloy   # fill in LOKI_URL and credentials
```

### 3. Grant journal access

Alloy reads the journal directly:

```sh
usermod -aG systemd-journal alloy
systemctl restart alloy
```

### 4. Verify

```sh
systemctl status alloy
journalctl -u alloy -f          # the collector's own logs — watch for auth
                                # or endpoint errors on first push
```

Alloy's UI at `http://localhost:12345` shows each component's health and the
number of entries it has forwarded, which is the fastest way to tell a
"reading nothing" problem from a "can't push" problem.

## Querying

Labels are deliberately few — `job`, `env`, `unit`, `service_name`, `level`,
`source`. Everything high-cardinality is structured metadata, filtered after
the stream selector:

```logql
# Everything from the guest microVM consoles
{job="maskin-agent-server", source="msb-exec"}

# One session's guest output — the question this pipeline exists to answer
{job="maskin-agent-server", source="msb-exec"} | session_id="<session-uuid>"

# Is the input-stream helper alive in any session, or dying silently?
{job="maskin-agent-server", source="msb-exec"} |= "input-stream"

# Guest stderr only
{job="maskin-agent-server", source="msb-exec"} | stream="stderr"

# Application-level problems, excluding guest chatter
{job="maskin-agent-server", level=~"warn|error"} | source=""
```

## Why `sessionId` is not a label

Loki creates one stream per unique label combination and its index grows with
that count. `sessionId` takes one value per agent session, without bound. As a
label it would produce an enormous number of very small streams: an index
larger than the logs it points at, slow queries, and — on any usage-billed
backend — a cost that scales with session count rather than log volume. This is
the most common way a Loki deployment becomes expensive.

Structured metadata (Loki 3.0+) gives the same exact-match filtering with no
index cost, which is why `session_id` and `stream` live there. If you add
fields to the pipeline later, the rule is: **bounded, small, and useful as a
first filter → label. Everything else → structured metadata.**

## Host settings this depends on

Two journald defaults will quietly undermine the pipeline.

**Rate limiting.** journald applies `RateLimitIntervalSec=30s` /
`RateLimitBurst=10000` per service and *drops* messages past the burst, leaving
only a "Suppressed N messages" note. `guest-log-stream.ts` rate-caps each
session at 200 lines / 100 KB per rolling 60s window, but several busy sessions
at once can still cross journald's burst — and losing diagnostics silently is
the exact failure this logging was built to end. The committed unit file
disables the limit for agent-server only (`LogRateLimitIntervalSec=0` in
`systemd/maskin-agent-server.service`); the per-session rate cap in the
application remains the real bound.

**Retention.** journald is the buffer between agent-server and the collector.
If it is small or volatile, an Alloy outage or a reboot loses the window you
would want to investigate. Check with `journalctl --disk-usage`, and set
something deliberate in `/etc/systemd/journald.conf`:

```ini
[Journal]
Storage=persistent
SystemMaxUse=2G
```

## Relationship to Sentry

Sentry and Loki are not alternatives here. `logger.error` calls
`Sentry.captureMessage`, so Sentry holds *exceptional* events with grouping and
alerting. Loki holds the full diagnostic stream, including the deliberately
non-exceptional guest console output that is routed to `logger.info` for this
reason — see the comment in `src/lib/guest-log-stream.ts`. Sending guest
stderr to Sentry would flood it with thousands of non-actionable events.
