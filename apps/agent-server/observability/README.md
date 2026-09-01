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

A third pipeline scrapes **agent-server's own `/metrics` endpoint**. It exists
to answer one question that neither of the others can: *what commit is each
host actually running.* That question cost real time twice — it was asked four
separate times during the #1450–#1454 wedge investigation and answered by
grepping container image layers, and #1465 discovered that the deploy workflow
had never installed the systemd unit at all, so the repo copy and the live copy
had silently diverged since someone hand-copied it once. It should be a
dashboard panel, not an investigation. See
[What commit is each host running](#what-commit-is-each-host-running).

Application instrumentation stops there, deliberately. `/metrics` currently
exposes `maskin_build_info` and nothing else — no session gauges yet, no
dispatch latency, no traces, no OpenTelemetry. The endpoint is built to be
extended (adding a metric is one call against the registry in
`src/lib/metrics.ts`), and the stalled-session detector is the next thing to
extend it.

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
| `alloy.alloy` | All three collector pipelines — journald → Loki, node_exporter → Prometheus, and agent-server `/metrics` → Prometheus. Commit-safe: every deployment-specific value is read from the environment. |
| `../src/lib/metrics.ts` | The registry and the `/metrics` Hono route. Add new metrics here. |
| `../src/lib/build-info.ts` | Resolves commit/version/instance/env. Commit and version are compile-time constants — see the note below. |
| `alloy.env.example` | The values you must supply, with guidance on where to find each. |
| `alerts/stalled-sessions.yaml` | Grafana alert rules for the stalled-session detector. Grafana Cloud cannot read them from disk — the file is the source of truth and is imported; see the header of the file itself. |
| `../src/lib/stall-tracker.ts` | The stall predicate: which sessions count as wedged, and why an idle session does not. |

## What this does *not* cover

This ships **the journald unit named by `AGENT_SERVER_SYSLOG_ID`, and nothing
else** — not even everything on the same machine. That filter is by design,
so an unrelated chatty service on the same machine cannot inflate the bill. The
cost of that filter is that **any other workload on the box is unshipped**, and
Docker containers in particular need their own `loki.source.docker` pipeline.

If the host also runs containers, see
[`observability/coolify-host/`](../../../observability/coolify-host/README.md),
which is the config for a containerised host and can be adapted.

### ⚠️ Do not conclude which host serves production from `docker ps`

An earlier revision of this section (#1465) inspected a host, found a full
Coolify stack running on it, and concluded from that alone that this was *the*
Coolify — rewriting this section around a coverage gap that turned out to be on
a different machine.

The containers were genuinely running. That was never the question. A Coolify
stack can be installed, healthy, and deploying **nothing at all**. Ask the
control plane what it has actually deployed:

```sh
docker exec coolify-db psql -U coolify -d coolify   -c 'select count(*) from applications'   -c 'select count(*) from application_deployment_queues'   -c 'select id, name, ip from servers'
curl -s http://127.0.0.1:8080/api/http/routers   # Traefik: what is actually routed
```

Zero applications and zero configured routers means that install serves nothing,
however healthy its containers look — and an abandoned stack is a candidate for
deletion, not for monitoring. Note also that Coolify installs a **sentinel**
container on remote servers it manages, so `coolify-sentinel` on a box is not by
itself evidence that the box runs Coolify; the `servers` table shows which
install claims it.

**Check state, not shape.** A wrong topology claim in a monitoring README is how
you end up with a green dashboard over an uncovered machine.

The **metrics** half is not subject to any of this: `node_exporter` measures the
whole machine, so CPU, memory and disk cover every other container's resource
usage too. It is the *logs* that are agent-server-only. Do not read a green
metrics dashboard as evidence that everything on the box is being logged.

## Current deployment

Deployment-specific facts — which host, which Grafana Cloud stack, which
numeric usernames, which access-policy token, the measured series count — are
**deliberately not in this repo**. It is open source and multi-tenant; a
committed hostname is both an unnecessary disclosure and a value that stops
being true for everyone else.

They live in `observability/deployment.local.md`, which is gitignored. Create it
from `observability/deployment.local.md.example` on first install and keep it
current — the point of recording them at all is so a future reader can tell
configuration from aspiration.

One thing worth stating here because it is a property of Grafana Cloud rather
than of any deployment: **the Loki and Prometheus usernames are different
numbers.** They are not interchangeable, and swapping them yields a 401 that
reads exactly like a bad token.

Verify an install end to end with:

```logql
{instance="$INSTANCE", job="maskin-agent-server"}
```

```promql
node_uname_info
```

The first should return log lines; the second should come back labelled
`job="integrations/node_exporter"` with your `instance` and `env` values. Then
confirm Grafana Cloud's "Linux node / overview" renders live CPU, memory and
disk for the host.

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

This is the **first-install** step only. Once `/etc/alloy/config.alloy` exists,
the `agent-server-deploy` workflow keeps it in sync with `alloy.alloy` on every
deploy — validating it and rolling back if Alloy will not reload onto it — so
do not hand-edit the installed copy; change the repo copy instead. The deploy
skips this sync entirely on a host that has no `/etc/alloy/config.alloy`, which
is what makes this step the bootstrap.

```sh
cp apps/agent-server/observability/alloy.alloy /etc/alloy/config.alloy
```

Credentials are **not** deployed and stay host-local. Note the `>>` — the Alloy
package owns `/etc/default/alloy` and ships `CONFIG_FILE`, `CUSTOM_ARGS` and
`RESTART_ON_UPGRADE` in it, which `alloy.service` reads on startup. Overwriting
the file with `cp` blanks `CONFIG_FILE` and Alloy then starts with no config
path at all:

```sh
cat apps/agent-server/observability/alloy.env.example >> /etc/default/alloy
chmod 600 /etc/default/alloy   # it is about to hold a write-scoped API token
$EDITOR /etc/default/alloy     # fill in LOKI_* and PROM_* URLs and credentials
```

`LOKI_*` and `PROM_*` are **different endpoints with different numeric
usernames** — Grafana Cloud runs logs and metrics on separate clusters. One
access policy token can serve both if it is scoped `logs:write` +
`metrics:write`, but the usernames do not interchange. Crossing them produces a
401 that reads like an invalid token; if only one of the two pipelines
authenticates, that mix-up is the first thing to check.

**Set `AGENT_SERVER_INSTANCE` explicitly, in two files.** It defaults to the
hostname, and cloud images are routinely named after the image rather than the
role — meaningless in a dashboard, identical on every box built from that image,
and liable to change on a rebuild. Pick something you would recognise at 3am
(`agent-1`, say). This label
is applied to all three pipelines and is what the correlation workflow below
joins on, so changing it later silently splits every saved query at that moment.

Two files, because two processes read it and they do not share an environment:

```sh
# Alloy — for the labels it stamps on logs and metrics
$EDITOR /etc/default/alloy                        # AGENT_SERVER_INSTANCE, DEPLOY_ENV

# agent-server — for the labels it puts inside maskin_build_info
$EDITOR /opt/maskin/apps/agent-server/.env        # AGENT_SERVER_INSTANCE, DEPLOY_ENV,
                                                  # METRICS_PORT (default 9464),
                                                  # AGENT_SERVER_STALL_THRESHOLD_MS
                                                  #   (default 300000, floor 90000 —
                                                  #    see "Stalled sessions" below)
```

`METRICS_PORT` (agent-server's `.env`) and `AGENT_SERVER_METRICS_PORT`
(`/etc/default/alloy`) must agree — the first decides where the endpoint
listens, the second where Alloy looks for it. A mismatch is a permanently failed
scrape (`up{job="maskin-agent-server"} == 0`) against a service that is
otherwise perfectly healthy. Both default to 9464, so leaving both alone works.

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

Later edits go to the repo copy, and the deploy workflow runs this same
`alloy validate` before installing — refusing to replace a working live config
with one that does not parse, and restoring the previous config if Alloy will
not reload onto the new one. Run it locally too if you want the feedback
before pushing.

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
"reading nothing" problem from a "can't push" problem. Check all **ten**
components — all three relabel components included, since those are where the
`job` label is set and a mistake there is invisible everywhere else (see the
gotcha under [Querying metrics](#querying-metrics)):

| Component | Pipeline |
|---|---|
| `loki.relabel.journal` | logs — sets `unit`, `service_name`, `job` |
| `loki.source.journal` | logs — reads the journal |
| `loki.process.agent_server` | logs — parses the NDJSON, splits labels vs metadata |
| `loki.write.default` | logs — pushes to Loki |
| `prometheus.exporter.unix.host` | host metrics — node_exporter |
| `discovery.relabel.host` | host metrics — sets `instance`, `env`, `job` |
| `prometheus.scrape.host` | host metrics — 60s scrape |
| `discovery.relabel.agent_server` | app metrics — sets `instance`, `env`, `job` |
| `prometheus.scrape.agent_server` | app metrics — 60s scrape of `127.0.0.1:9464/metrics` |
| `prometheus.remote_write.default` | metrics — pushes to Prometheus (shared by both metrics pipelines) |

Before blaming Alloy for the app pipeline, check the endpoint directly on the
box — this separates "agent-server isn't serving" from "Alloy isn't scraping":

```sh
curl -s http://127.0.0.1:9464/metrics | grep maskin_build_info
```

Connection refused here means agent-server is down, or `METRICS_PORT` in
`apps/agent-server/.env` disagrees with `AGENT_SERVER_METRICS_PORT` in
`/etc/default/alloy`. Note the endpoint is loopback-only by design, so this must
be run on the host — it will not answer from your laptop, and that is correct.

In Grafana, confirm each pipeline independently before trusting a dashboard:

```logql
{job="maskin-agent-server"}          # logs arriving
```
```promql
up{job="integrations/node_exporter"}  # host scrape succeeding; 1 = healthy
node_uname_info                       # host metrics arriving, with the instance label
up{job="maskin-agent-server"}         # app scrape succeeding; 1 = healthy
maskin_build_info                     # app metrics arriving — and the commit answer
```

If `up` is 1 but no `node_*` series exist, the scrape is working and
remote_write is not — check `PROM_URL` and `PROM_USERNAME`.

If `maskin_build_info` is present but `commit="unknown"`, the pipeline is fine
and the *build* is the problem — see
[Where the commit value comes from](#where-the-commit-value-comes-from).

### 7. Set a Grafana Cloud usage alert — on day one, not after the first bill

Do this before you consider the setup finished. See
[Volume and the free-tier ceiling](#volume-and-the-free-tier-ceiling) for why
the worst case sits just under the limit rather than comfortably below it.

Grafana → **Cost Management and Billing → Usage Alerts** (not the grafana.com
org portal — the alerts live inside the stack). Each alert needs a **contact
point**, and the list is empty on a new stack, so create one first under
Alerting → Notification configuration; the alert cannot be saved without it.

**Already configured on this stack (2026-08-26):**

| Alert | Fires at | Contact point |
|---|---|---|
| Logs Usage: 70% of 50 GiB | 35 GiB/month | `usage-alerts-email` |
| Metrics Usage: 10% over 7,000 series | 7,700 series | `usage-alerts-email` |

Note the two products use **different wording**: Logs levels are "% *of*
threshold", Metrics levels are "% *over* threshold". So the Logs threshold is
set to the full 50 GiB allowance and the level does the derating, whereas the
Metrics threshold is set to 7,000 — the point you want to know about — and the
level fires above it.

Series count is the one to watch on the metrics side: it steps up discretely
when a collector is enabled or a host is added, rather than drifting, so an
alert catches a config change the same day it lands.

### 8. Install the Grafana Cloud "Linux Server" integration

**Matching the `job` label is necessary but not sufficient.** The prebuilt
dashboards do not exist in your stack until you install the integration —
before that, `/dashboards` simply has no Linux pages in it, whatever your
metrics are labelled.

Grafana → Connections → Add new connection → **Linux Server** → *Install
dashboards and alerts*. You do **not** need its "Install Alloy" or
"Configuration details" steps; `alloy.alloy` already does that job, and its
generated snippet would overwrite this one.

That installs seven dashboards (overview, CPU and system, memory, network,
filesystem and disks, logs, fleet overview) plus alert rules and recording
rules. The recording rules matter: some panels (e.g. CPU count) query
`instance:node_num_cpu:sum`, which only exists once the integration creates
it, and which only produces data going forward — so expect a few blank panels
for the first minutes after install, not a misconfiguration.

**Verified**: with the collector set in `alloy.alloy`, "Linux node / overview"
populates fully — uptime, hostname, kernel, OS, CPU count, memory total, swap,
root mount size, CPU usage per core, and load average — with the `instance`
variable auto-selecting the host.

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

The **host** series below carry `job="integrations/node_exporter"`, plus the
`env` and `instance` labels shared with logs. agent-server's own application
series carry `job="maskin-agent-server"` instead — same `env` and `instance`,
different job, because they describe the process rather than the box. Replace
`agent-1` in the queries below with your `AGENT_SERVER_INSTANCE` value.

That `job` value is Grafana Cloud's own convention, and matching it is what
lets their prebuilt **Linux Server** dashboards find this host (see setup step
8 — you must also install the integration). The queries below are for ad-hoc
investigation and for the correlation workflow; for "how is the box doing" at a
glance, use the prebuilt dashboards rather than rebuilding them here.

> **Gotcha, learned the hard way.** `job` is set in a **relabel rule** in all three
> pipelines, never as a static label. `prometheus.exporter.unix` pre-stamps
> `job="integrations/unix"` and `loki.source.journal` pre-stamps
> `job="<component id>"`, and both beat a static value. Getting this wrong is
> silent — `alloy validate` passes, components report healthy, entries are
> accepted with 204s, nothing is dropped, and every query here returns nothing,
> because the data landed under a `job` value you never query. If a query in
> this file comes back empty, check the `job` label values in Grafana's label
> browser before assuming the pipeline is broken.

### What these metrics cannot tell you

Nothing in the *host* pipeline is per-agent-session. No host collector can see
inside agent-server; node_exporter does not know what a session is. `processes`
gives aggregate process and thread counts — a proxy for how much work the box
is doing — and the filtered `systemd` collector gives agent-server's up/down
state and restart count, but neither attributes anything to a session.

The application pipeline can, and does — but only in **aggregate**. The
`maskin_sessions_*` gauges below are counts by state, never per-session: a
`session_id` label is one series per session forever, which is the metrics-side
version of the Loki mistake described in
[Why `sessionId` is not a label](#why-sessionid-is-not-a-label). Getting from
the count to the session id is the log pivot, not a bigger metric.

Session-level detail lives in the **logs**, where every line carries
`session_id`. The division of labour: metrics tell you the box is struggling,
logs tell you which session caused it, and the correlation workflow below is
how you get from one to the other.

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

# --- agent-server service health (systemd collector, filtered to its unit) ---

# Is agent-server up? 1 = active. The `systemd` collector is restricted to
# this one unit, so these are the only per-unit series in the stack.
node_systemd_unit_state{name="maskin-agent-server.service", state="active"}

# Restarts. The number that actually matters: Restart=on-failure means a
# crash-looping service still reads "active" in a status check, and only the
# rising restart count gives it away.
increase(node_systemd_service_restart_total{name="maskin-agent-server.service"}[1h])

# How much work is the box doing? Aggregate, not per-session — see above.
node_processes_threads
sum(node_processes_state)
```

## Stalled sessions

The one alert on this page that exists to catch a *silent* failure. Everything
else here improves diagnosis; this improves detection.

```promql
# The alerting arms. Non-zero = someone is sitting in front of a chat that will
# never answer.
maskin_sessions_stalled{reason="never_seeded"}
maskin_sessions_stalled{reason="undelivered"}

# Recorded, not alerted on (yet) — see below.
maskin_sessions_stalled{reason="no_output"}

# Denominator: how many live sessions this process is tracking.
maskin_sessions_tracked

# The restart blind spot. Non-zero means the stalled count above is INCOMPLETE.
maskin_sessions_unobserved
```

| Arm | Means | Alerted? |
|-----|-------|----------|
| `never_seeded` | An interactive session is live with no turn ever delivered and no output. The `seedInteractiveTurn` shape — the guest blocks forever on a stdin nothing writes to. | Yes, `for: 2m` |
| `undelivered` | A turn was enqueued and the guest's acked high-water mark never advanced past it. The dead-socket shape (PRs #1450–#1454). | Yes, `for: 2m` |
| `no_output` | The guest acked the turn — it reached the CLI — and nothing has come back since. | **No.** Recorded only. |

**Why an idle session is not a stalled session.** A chat sitting quiet because
the human hasn't typed is healthy, and is the common case. Alerting on "no
output" would fire constantly, we would mute it, and it would be worse than
nothing. Every arm above requires an *asymmetry*: input pending and output
absent, or (for `never_seeded`) an interactive session where neither ever
happened.

**Why `no_output` is not routed anywhere.** A genuinely long tool call or model
response that prints nothing is indistinguishable from a wedge from outside the
guest. Any output line resets its clock, so a chatty tool call never trips it —
but a silent one would. Watch the gauge for a week, set the threshold from the
observed distribution, and then add the third rule to
`alerts/stalled-sessions.yaml`. Do not guess it.

**The threshold** is `AGENT_SERVER_STALL_THRESHOLD_MS`, default 5 minutes,
read at startup — tuning it is an env change and a restart, not a deploy. The
floor is 90s, enforced at parse time, because that is `input-stream.js`'s
`IDLE_TIMEOUT_MS`: below it, every healthy between-re-dials window looks like a
wedge. The 5-minute default is ~3.3× that interval and is derived from the
code, **not** from the observed re-dial distribution — the
`input-stream: exiting with code N (lastSeq=...)` lines that would give a real
p99 only started shipping with #1462. Once there is a week of them, re-derive
it:

```logql
{instance="agent-1", source="msb-exec"} |= "input-stream: exiting with code"
```

and move the env var to the observed p99 plus headroom.

### A firing alert that clears after a deploy is NOT evidence of a fix

The detector's state is in-memory. A restart erases every session's turn
history, and `reconcileOnBoot` re-registers the surviving sessions as
**unobserved**, not healthy: they are excluded from every stall arm and counted
in `maskin_sessions_unobserved` instead. So the stalled count drops to zero on
every deploy regardless of what is actually happening inside those sessions.

This matters precisely because we deploy when we are shipping a fix and most
want to know whether it worked — the loop that made PRs #1450–#1454 take days.
When a stall alert resolves, check `maskin_sessions_unobserved` and
`maskin_build_info` for the same `instance` in the same window: if the commit
changed at the moment the alert cleared, you learned nothing. Wait for the next
turn on a fresh session and watch again.

### Pivoting from a stall alert to the session id

The alert gives a count, on purpose. The id is in the logs. This is the same
correlation the CPU walkthrough below uses, with a narrower starting point.

**1. Confirm the count and get the exact `instance` and window.**

```promql
maskin_sessions_stalled{reason=~"never_seeded|undelivered"} > 0
```

Note the `instance` (e.g. `agent-1`) and when the series went non-zero. The
session has been wedged since roughly that timestamp minus the threshold.

**2. Read the guest consoles for that host and window.**

```logql
{instance="agent-1", source="msb-exec"}
```

Set the time range to the window from step 1. Every line carries `session_id`
as structured metadata.

**3. Narrow to the input path — this is where both known wedges show.**

```logql
{instance="agent-1", source="msb-exec"} |= "input-stream"
```

A healthy session re-dials and reports a rising `lastSeq`. A wedged one either
stops appearing entirely (`never_seeded`: it never got a turn to report) or
re-dials forever with the same `lastSeq` (`undelivered`).

**4. Cross-check the host side for the same session.**

```logql
{instance="agent-1", job="maskin-agent-server"} |= "input:"
```

`turn written to stream` with no subsequent `stream registered` carrying a
higher `ackedThrough` is the host-side signature of `undelivered`. For
`never_seeded`, the giveaway is the *absence* of any `input:` line at all for a
session that `POST /sessions` accepted.

**5. Take the session id and pin the whole session's output.**

```logql
{instance="agent-1", source="msb-exec"} | session_id="<uuid-from-step-3>"
```

## What commit is each host running

The point of the whole third pipeline. `maskin_build_info` is a gauge pinned at
`1` whose **labels** are the payload — the standard `*_build_info` shape. The
value never changes and carries no information; you query the labels.

```promql
# The dashboard panel. One row per host: commit, version, env.
# Render as a Grafana "Table" panel with Format = Table and Instant = on.
maskin_build_info

# One host.
maskin_build_info{instance="agent-1"}

# Are all hosts on the same commit? A result with more than one row means a
# deploy reached some boxes and not others.
count by (commit) (maskin_build_info)

# Did the box actually pick up the last deploy? Compare against the SHA of
# origin/main. Returns nothing when they match, which is the healthy state.
maskin_build_info{commit!="<sha-of-origin-main>"}

# Is the endpoint even being scraped? 0 (or absent) means agent-server is down,
# mid-restart, or the port in /etc/default/alloy disagrees with METRICS_PORT.
up{job="maskin-agent-server"}
```

`commit="unknown"` is a real, expected value, not a bug: it means the bundle was
built somewhere without git metadata and without a `MASKIN_COMMIT_SHA` override.
On the normal deploy path it should never appear — `agent-server-deploy.yml`
does `git reset --hard origin/main` and then builds *on the box, inside the work
tree*, so `git rev-parse HEAD` there is exactly the deployed commit. Seeing
`unknown` in production means the build ran somewhere unexpected.

### Where the commit value comes from

It is baked in at **build time** by esbuild's `define`, which replaces the
`process.env.MASKIN_COMMIT_SHA` read in `src/lib/build-info.ts` with a string
literal. Precedence in `build.mjs`: `MASKIN_COMMIT_SHA` → `GITHUB_SHA` →
`git rev-parse HEAD` → `'unknown'`.

Nothing is read from disk at runtime, and that constraint is load-bearing. The
obvious implementation — resolving `.git/HEAD` relative to `import.meta.url` —
is broken by this app's own build: `build.mjs` bundles to a single flat
`dist/index.js`, so at runtime `import.meta.url` points at the bundle rather
than at the source file, and the path walks into a directory that does not
exist. It works perfectly under `tsx` and throws `ENOENT` on every production
boot. That is not hypothetical; see *Runtime File Reads Relative to
`import.meta.url`* in `.claude/rules/known-pitfalls.md`.

**If you change how build info is resolved, verify against the built bundle,
not `tsx`:**

```bash
pnpm --filter @maskin/agent-server build
node apps/agent-server/dist/index.js &
curl -s http://127.0.0.1:9464/metrics | grep maskin_build_info
```

### Why the endpoint is loopback-only

`/metrics` is served by a **second HTTP listener bound to `127.0.0.1`**
(`METRICS_PORT`, default 9464), not by a route on the main listener.

It is unauthenticated — Prometheus scrapers do not speak our bearer scheme, and
handing a credential to a collector on the same box buys nothing. That makes
the bind address the actual security boundary. The main listener is `0.0.0.0`:
reachable from the public internet *and* from every session microVM, so a
`/metrics` route on it would publish this box's build identity — and, once the
session gauges land, its live workload — to anything that can reach port 3001,
including agent code running inside sessions. Alloy scrapes from the same host,
so loopback costs nothing and closes that off in the kernel rather than in a
middleware someone can reorder later.

Set `METRICS_PORT=0` to disable the listener entirely (local dev, or a box with
no collector).

### The two-file trap for `instance` and `env`

`AGENT_SERVER_INSTANCE` and `DEPLOY_ENV` are now read by **two processes that
read two different files**:

| Process | File |
|---------|------|
| Alloy | `/etc/default/alloy` |
| agent-server | `/opt/maskin/apps/agent-server/.env` |

Set the same value in both. Setting it only in Alloy's file leaves
`maskin_build_info` carrying `instance="<hostname>"` from the application while
the collector relabels the series itself to `instance="agent-1"` — the series
label and the label *inside* build info then disagree, which is confusing at
exactly the moment you least want it. (The collector's relabel rule wins for
selection purposes, so queries still work; it is the payload that lies.)

Both are also in `turbo.json` `globalPassThroughEnv`, along with `METRICS_PORT`
and `MASKIN_COMMIT_SHA` — turbo filters unlisted env vars silently.

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

The result series is labelled `instance="agent-1"`. Note the window from the
graph — say 02:10–02:30 UTC.

**2. Read that host's logs for that window, using the same label.**

```logql
{instance="agent-1", job="maskin-agent-server"}
```

Set the dashboard/Explore time range to 02:10–02:30. Because `instance` means
the same thing in both queries, this is the same machine, with no
hostname-versus-address translation and no guessing.

**3. Narrow to what the guests were doing.**

```logql
{instance="agent-1", source="msb-exec"}
```

These are the microVM console lines — the diagnostics PR #1462 added. If a
session was thrashing, its output is here.

**4. Attribute it to one session.**

```logql
{instance="agent-1", source="msb-exec"} | session_id="<uuid-from-step-3>"
```

**5. Rule out the application itself.**

```logql
{instance="agent-1", level=~"warn|error"} | source=""
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
- **Metrics scale with hosts and collectors, not traffic.** MEASURED: **887
  active series** for this host against the 10k allowance — about 9%, leaving
  room for several more boxes. The one collector that could change that is
  `systemd`, which is enabled but restricted to agent-server's own unit;
  unfiltered it would cost roughly 2,500 series (513 units on this host).
  `alloy.alloy` documents the fixed-vs-unbounded reasoning behind every
  collector — read it before adding one, and re-measure rather than estimating:
  adding ten collectors here was predicted at 1,500–2,500 series and actually
  cost 887.
- **The application pipeline adds two series per host, total.**
  `maskin_build_info` is one, `up{job="maskin-agent-server"}` is the other. It
  is a rounding error against the 887 above, and it stays that way *only*
  because every label on it is bounded — commit, version, instance, env all
  take one value per deployed build per host. Adding a `session_id` label to
  anything here would convert this pipeline from two series to one-per-session-
  forever; that is why `src/lib/metrics.ts` states the rule at the top of the
  file. Session gauges must be aggregate counts by state.

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

How far away is it in practice? MEASURED 2026-08-26: agent-server writes about
**10 lines/minute** (13,990 in 24h) against journald's **20,000/minute**, and
**zero** messages have been suppressed in the last 14 days. So this is
insurance, not a live problem — reaching the burst would take roughly 100
sessions all emitting guest output at their per-session cap simultaneously.

The unit file is installed by `.github/workflows/agent-server-deploy.yml`,
which copies it to `/etc/systemd/system/` and runs `daemon-reload` before
restarting, so the setting lands on the next deploy with no manual step. That
step exists because agent-server is **not** containerised — it runs as a plain
Node process under systemd, so its runtime settings live in a file outside
`/opt/maskin` that the code deploy would otherwise never touch. Before that
step existed, edits to the unit sat in the repo doing nothing until someone
copied them by hand. (The `agent-base` and `browser-sidecar` images *do* ship
automatically, but those are the images sessions run *inside*, not this
service.)

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
