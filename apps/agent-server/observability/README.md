# Shipping agent-server logs and host metrics off the box

agent-server writes one NDJSON object per line to stdout/stderr. On a deployed
host systemd captures that into journald, which is enough to answer most
questions with `journalctl` — but only while you are ssh'd into that specific
box, and only for as long as journald's retention window holds.

This directory contains the host-side config for shipping those lines to a log
backend instead. The example uses [Grafana Alloy](https://grafana.com/docs/alloy/latest/)
→ Loki, because that is what we run; nothing about the application assumes it.

The same Alloy install also scrapes **host metrics** — CPU, memory, disk,
network, load — and pushes them to Grafana Cloud Prometheus. That half exists
because logs cannot answer "what is the CPU on the Finland box doing", which
was the original reason for ssh'ing into it. Both pipelines carry the same
`env` and `instance` labels, so a spike on a metrics dashboard can be pivoted
to that host's logs for the same instant — see
[Correlating metrics and logs](#correlating-metrics-and-logs).

Note that metrics here are **host** metrics only. There is no `/metrics`
endpoint on agent-server and no application instrumentation (session gauges,
dispatch latency, traces); that is separate, larger work.

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
| `alloy.alloy` | Both collector pipelines — journald → Loki, and node_exporter → Prometheus. Commit-safe: every deployment-specific value is read from the environment. |
| `alloy.env.example` | The values you must supply, with guidance on where to find each. |

## What this does *not* cover

This ships **the `maskin-agent-server` systemd unit, and nothing else** — not
even everything on the same machine.

Verified on the Finland box (2026-08-26): alongside agent-server it also runs a
full Coolify stack in Docker — `coolify`, `coolify-db` (Postgres 15),
`coolify-proxy` (Traefik), `coolify-realtime`, `coolify-redis`,
`coolify-sentinel` — plus one `agent-base` container that has been up two
months. None of those ship anywhere. The journald source here is filtered to
`SYSLOG_IDENTIFIER=maskin-agent-server` precisely so an unrelated chatty
service cannot inflate the bill, and the cost of that is that Docker logs need
their own `loki.source.docker` pipeline. That is a real gap and it is on *this*
host, not only some other one.

`apps/dev`, `apps/web` and SeaweedFS are **not** on this box — nothing is
listening on 3000, 5173 or 8333; only agent-server on 3001. Wherever they run,
they are also unshipped.

The **metrics** half is not subject to any of this: `node_exporter` measures the
whole machine, so CPU, memory and disk cover the Coolify containers' resource
usage too. It is the *logs* that are agent-server-only. Do not read a green
metrics dashboard as evidence that everything on the box is being logged.

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
$EDITOR /etc/default/alloy   # fill in LOKI_* and PROM_* URLs and credentials
```

`LOKI_*` and `PROM_*` are **different endpoints with different numeric
usernames** — Grafana Cloud runs logs and metrics on separate clusters. One
access policy token can serve both if it is scoped `logs:write` +
`metrics:write`, but the usernames do not interchange. Crossing them produces a
401 that reads like an invalid token; if only one of the two pipelines
authenticates, that mix-up is the first thing to check.

**Set `AGENT_SERVER_INSTANCE` explicitly.** It defaults to the hostname, and
the current Finland box's hostname is `Ubuntu-2404-noble-amd64-base` — a Hetzner
image name, meaningless in a dashboard, identical on every box built from that
image, and liable to change on a rebuild. Pick something you would recognise at
3am (`finland-1`). This label is applied to both pipelines and is what the
correlation workflow below joins on, so changing it later silently splits every
saved query at that moment.

### 3. Validate the config before restarting anything

`alloy validate` parses the config and checks component wiring — misspelled
argument names, blocks on components that do not accept them, references to a
component that does not exist. It takes seconds and it is much better feedback
than a service that fails to come back up.

```sh
alloy validate /etc/alloy/config.alloy
```

The committed config **passes** against Alloy **v1.19.1** (`linux/amd64`, build
tag `promtail_journal_enabled`, which `loki.source.journal` requires). `alloy
fmt` reports no changes — it is already canonical, so a formatting diff on this
file means someone hand-edited it.

Note that it validates *structure*, not reachability: it will happily pass a
config with the wrong `PROM_URL`, or a Loki username in the Prometheus slot.
Those only show up in step 6. What it does catch is the class of error that
otherwise takes the service down on restart — a misspelled argument
(`set_collectorz`) or a reference to a component that does not exist both fail
with an exit code and a line number.

If you edit the config later, run this again before `systemctl restart alloy`,
not after.

### 4. Check the filesystem exclusions against reality

**Already done for the current Finland box (2026-08-26) — result recorded
below.** Re-run it if msb is upgraded or the host is rebuilt.

The `filesystem` block excludes by filesystem *type* rather than by path,
specifically so it does not depend on knowing where microsandbox keeps its
storage:

```sh
# What, if anything, does msb mount on the host?
mount | grep -iE 'msb|microsandbox'

# What will node_exporter actually report after exclusions?
df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay
```

**Measured result, with two msb sandboxes running:** the first command returns
**zero rows**. microsandbox creates no host mounts per microVM — it is
libkrun/KVM with the guest rootfs inside the VM, not a host-assembled overlay
the way Docker does it. The exclusion is therefore belt-and-braces rather than
load-bearing, and is kept because the failure mode it guards is silent.

The second command returns exactly two filesystems, both stable:

```
/dev/md2  ext4  436G  /
/dev/md1  ext3  989M  /boot
```

That is the entire filesystem series set for this host. The 7 `overlay` and 7
`nsfs` mounts also present belong to Docker (the Coolify stack) and are
excluded twice over — by type, and by the `/var/lib/docker/` path rule.

If a future msb release *does* start mounting per sandbox, the tell is a mount
that appears and disappears with a session: run `mount | grep` while one is
live, then again after it ends, and add the type if it is not already excluded.

### 5. Grant journal access

Alloy reads the journal directly:

```sh
usermod -aG systemd-journal alloy
systemctl restart alloy
```

### 6. Verify

```sh
systemctl status alloy
journalctl -u alloy -f          # the collector's own logs — watch for auth
                                # or endpoint errors on first push
```

Alloy's UI at `http://localhost:12345` shows each component's health and the
number of entries it has forwarded, which is the fastest way to tell a
"reading nothing" problem from a "can't push" problem. Check all five
components: `loki.source.journal`, `loki.write`, `prometheus.exporter.unix`,
`prometheus.scrape`, `prometheus.remote_write`.

In Grafana, confirm each half independently before trusting a dashboard:

```logql
{job="maskin-agent-server"}          # logs arriving
```
```promql
up{job="integrations/node_exporter"}                        # scrape succeeding; 1 = healthy
node_uname_info                       # metrics arriving, with the instance label
```

If `up` is 1 but no `node_*` series exist, the scrape is working and
remote_write is not — check `PROM_URL` and `PROM_USERNAME`.

### 7. Set a Grafana Cloud usage alert — on day one, not after the first bill

Do this before you consider the setup finished. See
[Volume and the free-tier ceiling](#volume-and-the-free-tier-ceiling) for why
the worst case sits just under the limit rather than comfortably below it.

Grafana Cloud → Billing/Usage → set alerts at roughly 70% of each allowance:

- **Logs** — 50 GB/month free tier; alert around 35 GB
- **Metrics** — 10k active series free tier; alert around 7k

Series count is the one to watch on the metrics side: it steps up discretely
when a collector is enabled or a host is added, rather than drifting, so an
alert catches a config change the same day it lands.

## Querying logs

Labels are deliberately few — `job`, `env`, `instance`, `unit`, `service_name`,
`level`, `source`. Everything high-cardinality is structured metadata, filtered
after the stream selector:

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

## Querying metrics

All series carry `job="integrations/node_exporter"`, plus the `env` and
`instance` labels shared with logs. Replace `finland-1` with your
`AGENT_SERVER_INSTANCE` value.

That `job` value is Grafana Cloud's own convention, and matching it is worth
doing: their prebuilt **Linux Server** integration dashboards filter on exactly
this string, so they populate for this host without any panel building. The
queries below are for ad-hoc investigation and for the correlation workflow —
for "how is the box doing" at a glance, use the prebuilt dashboards rather than
rebuilding them here.

```promql
# CPU utilisation, 0–1, averaged across cores. The idle-mode subtraction is
# the standard idiom: node_exporter reports time *spent*, per mode, and idle
# is the only mode whose absence means "busy" regardless of why.
1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle", job="integrations/node_exporter"}[5m]))

# Per-core, to tell "one saturated core" from "the whole box is busy" — the
# difference between a stuck session and genuine capacity exhaustion.
1 - rate(node_cpu_seconds_total{mode="idle", job="integrations/node_exporter"}[5m])

# Memory pressure. MemAvailable, not MemFree: page cache is reclaimable, so
# MemFree reads alarmingly low on a perfectly healthy box.
1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

# Load average relative to core count. >1 means the run queue is backed up.
node_load5 / count without (cpu, mode) (node_cpu_seconds_total{mode="idle"})

# Root filesystem used fraction — microVM images and agent workspaces live here
1 - (node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"})

# Disk fill RATE, as hours until full at the current trend. Answers "should I
# act today" in a way a percentage never does. Negative = draining, ignore.
node_filesystem_avail_bytes{mountpoint="/"}
  / -deriv(node_filesystem_avail_bytes{mountpoint="/"}[6h]) / 3600

# Disk I/O saturation — fraction of wall time the device spent busy
rate(node_disk_io_time_seconds_total[5m])

# Network throughput per interface, bytes/sec
rate(node_network_receive_bytes_total{device!="lo"}[5m])
rate(node_network_transmit_bytes_total{device!="lo"}[5m])
```

## Correlating metrics and logs

This is what the shared `instance` label buys, and the reason it is worth the
care taken to keep it identical on both pipelines.

**Scenario.** CPU on the Finland box pins at ~100% for twenty minutes
overnight. You want to know which sessions were running and what their guests
were doing.

**1. Find the spike, and get its exact `instance` and time range.**

```promql
1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle", job="integrations/node_exporter"}[5m])) > 0.9
```

The result series is labelled `instance="finland-1"`. Note the window from the
graph — say 02:10–02:30 UTC.

**2. Read that host's logs for that window, using the same label.**

```logql
{instance="finland-1", job="maskin-agent-server"}
```

Set the dashboard/Explore time range to 02:10–02:30. Because `instance` means
the same thing in both queries, this is the same machine, with no
hostname-versus-address translation and no guessing.

**3. Narrow to what the guests were doing.**

```logql
{instance="finland-1", source="msb-exec"}
```

These are the microVM console lines — the diagnostics PR #1462 added. If a
session was thrashing, its output is here.

**4. Attribute it to one session.**

```logql
{instance="finland-1", source="msb-exec"} | session_id="<uuid-from-step-3>"
```

**5. Rule out the application itself.**

```logql
{instance="finland-1", level=~"warn|error"} | source=""
```

If this is empty across the window, agent-server was healthy and the CPU
belonged to guest workloads — which is the answer that previously required an
ssh session and `top`.

In Grafana, keeping the metrics panel and the logs panel on one dashboard with
a shared time picker collapses steps 1 and 2 into a single drag on the graph.

## Volume and the free-tier ceiling

Worth knowing before the first bill, because the worst case is closer to the
limit than it looks.

`guest-log-stream.ts` caps guest console output at **100 KB per rolling 60s
window, per session**. A single session held at that cap continuously produces:

```
100 KB × 1440 windows/day  ≈  144 MB/day/session
```

Ten concurrently saturated sessions for a full month:

```
144 MB × 10 × 30  ≈  43 GB/month
```

against Grafana Cloud's **50 GB/month free-tier logs allowance**. The headroom
is roughly 14%, not an order of magnitude, and it shrinks as concurrency grows:
twelve saturated sessions would exceed the allowance.

**Measured against that, the actual figure is three orders of magnitude
smaller.** On the Finland box (2026-08-26), agent-server emitted **2.4 MB over
24 hours** — about **74 MB/month**, or **0.15%** of the allowance. Only 273 of
those lines carried `source=msb-exec`, so guest console output is currently a
rounding error rather than the dominant term. Every unit on the box together
came to 10.2 MB/day.

Both numbers are worth keeping. The 74 MB is what to expect; the 43 GB is what
the design permits if sessions ever do saturate, and the gap between them is
the reason the ceiling is a documented ceiling rather than a limit anyone has
felt. Do not size the alert off the measured figure — the point of the alert is
to fire when reality starts moving toward the ceiling.

Two things make this worth an explicit alert rather than a note:

- **The application cap is now the only bound.** `LogRateLimitIntervalSec=0` in
  the unit file deliberately removed journald's independent backstop, because
  that backstop dropped lines silently. Good tradeoff for diagnostics; it does
  mean nothing downstream will quietly throttle a runaway.
- **Metrics scale with hosts and collectors, not traffic.** ~500–1000 series
  for this host against a 10k active-series allowance leaves room for several
  more boxes, but enabling the `systemd` or `processes` collectors "for
  completeness" can multiply it in one commit. `alloy.alloy` documents which
  collectors are deliberately off and why — read that comment before adding
  one.

Set the usage alerts in [step 7](#7-set-a-grafana-cloud-usage-alert--on-day-one-not-after-the-first-bill).

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
