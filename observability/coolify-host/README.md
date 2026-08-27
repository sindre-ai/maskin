# Shipping a Coolify host's logs and metrics off the box

Host-side observability config for a server running `docker-compose.prod.yml`
under [Coolify](https://coolify.io) — the `app` container (apps/dev serving
apps/web), SeaweedFS, and Postgres, alongside the Coolify stack itself.

It is the containerised counterpart to
[`apps/agent-server/observability/`](../../apps/agent-server/observability/README.md),
which covers a host running agent-server as a plain systemd unit. The split is
about where logs come from, not about any particular deployment:

| | agent-server host | Coolify host |
|---|---|---|
| How the workload runs | systemd unit | Docker containers |
| Log source | journald | Docker API |
| Metrics | node_exporter + app `/metrics` | node_exporter + SeaweedFS `/metrics` |

Everything else is deliberately identical — same label vocabulary (`env`,
`instance`, `job`), same scrape interval, same WAL settings. A query written
against one works against the other with only `instance` changed.

Nothing here hardcodes a host, address, or credential: every deployment-specific
value is read from the environment. See `alloy.env.example`.

## Files

| File | Purpose |
|------|---------|
| `alloy.alloy` | The three collector pipelines — Docker API → Loki, node_exporter → Prometheus, SeaweedFS `/metrics` → Prometheus. |
| `alloy.env.example` | The values you must supply, with guidance on where to find each. |
| `alerts/seaweedfs-disk.yaml` | Grafana alert rules for SeaweedFS disk headroom. Grafana Cloud cannot read them from disk — the file is the source of truth and is imported; see the header of the file itself. |
| `../../docker-compose.prod.yml` | Where SeaweedFS's `-metricsPort` is turned on. Without that flag there is nothing to scrape. |

## Why SeaweedFS is the point of this directory

SeaweedFS holds every agent's persistent files — skills, learnings, memory —
pulled at session start and pushed at session end by
`apps/dev/src/services/agent-storage.ts`.

When it degrades, **sessions do not hard-fail**. The container stays up,
`/api/health` stays green, and Coolify shows a healthy deployment. What actually
happens is that agent file operations get slow or start failing individually,
and the result surfaces as an agent that has quietly forgotten something. That is
a silent-degradation failure — no exception, no 5xx, no page, just wrong
behaviour reported by a human days later — and it is invisible from both the
Coolify dashboard and the database, because neither can see this process at all.

### The metrics are off by default

SeaweedFS has a native Prometheus endpoint, but `weed server` serves it only when
`-metricsPort` is passed. On a default install there is nothing to scrape even
with a collector already running. Two flags are needed in
`docker-compose.prod.yml`:

```
exec weed server -s3 -s3.config=/tmp/s3.json -dir=/data \
  -metricsPort=9327 -metricsIp=0.0.0.0
```

`-metricsIp=0.0.0.0` is **not** redundant. It defaults to `-ip.bind`, which for
`weed server` resolves to the container's own eth0 address, not localhost.
Verified against SeaweedFS 4.16: with the port flag alone,
`wget http://127.0.0.1:9327/metrics` from *inside* the container is refused while
the same request to the container's IP succeeds. Binding `0.0.0.0` removes the
dependency on an address Docker can reassign.

The port is published as `127.0.0.1:9327:9327` — **loopback only**. The endpoint
is unauthenticated and exposes bucket and volume topology, so the bind address is
the security boundary, the same reasoning as agent-server's loopback `/metrics`
listener. Do not change this to `0.0.0.0` on the host side.

### What the endpoint carries

`weed server` runs master, volume, filer and S3 in **one process**, so the single
endpoint covers all four subsystems. Verified against 4.16:

| Metric | What it answers |
|---|---|
| `SeaweedFS_volumeServer_resource{type="avail"\|"all"\|"used"}` | free/total bytes on the data volume. The alert's input. |
| `SeaweedFS_volumeServer_volumes` / `SeaweedFS_volumeServer_max_volumes` | volume count vs cap. Hitting the cap fails **writes** while free bytes still look fine. |
| `SeaweedFS_s3_request_total` | S3 API calls by type. Absent until the first request — an empty panel on a fresh boot is expected, not broken. |
| `SeaweedFS_filerStore_request_seconds_bucket` | filer latency histogram; the "is it slow" signal. |
| `SeaweedFS_master_is_leader` | 1 on the leader. Single-node deployments should always read 1; a 0 means the master is unwell. |
| `SeaweedFS_build_info` | version/commit, the same role `maskin_build_info` plays for agent-server. |

### The disk alert

`alerts/seaweedfs-disk.yaml` has two rules: **warning** below 20% free, **page**
below 10%.

It uses SeaweedFS's own `SeaweedFS_volumeServer_resource` rather than
`node_filesystem_avail_bytes`. In a default Compose deployment the `seaweed_data`
volume lives under `/var/lib/docker`, so node_exporter reports its headroom as
whatever filesystem that path sits on — mixed in with every other container's
writes, the image cache, and Coolify's build artifacts. The SeaweedFS metric is
measured at the `/data` mount inside the container: it names the right thing, and
it keeps naming the right thing if the volume is later moved to a dedicated disk.

The flip side, and the reason the alert text says so: because the volume usually
shares a filesystem with Docker itself, low headroom is often **not** SeaweedFS's
doing. Check `docker system df` for reclaimable image and build-cache space
before assuming agent files are the cause — Coolify keeps old application images
after every deploy, and they are a common culprit.

Volume-count exhaustion is documented but deliberately **not** alerted on — see
the `NOT ALERTED ON` note in the alert file for why, and what to observe before
adding a third rule.

## ⚠️ Docker log discovery can fail silently on an IPv6-enabled network

Check this before concluding the logs pipeline works.

`discovery.docker` computes "network labels" for **every** network on the daemon,
in one pass, before returning any container. If any network's IPAM gateway is
recorded as a CIDR rather than a bare address — e.g. `fd00:1234:5678::1/64`
instead of `fd00:1234:5678::1` — the SD's address parser rejects it and discovery
aborts for **all** containers:

```
level=error component_id=discovery.docker.containers
  msg="Unable to refresh target groups"
  err="error while computing network labels: ParseAddr(\"…::1/64\"): unexpected character, want colon (at \"/64\")"
```

Docker accepts such a gateway at network-creation time, so the malformed value can
sit there indefinitely. The component still reports `state: healthy` and the two
metrics pipelines keep working — only the logs go missing. Observed with an
IPv6-enabled network created by Coolify's own installer, and reproduced on Alloy
v1.19.0 and v1.19.2, so upgrading is not the fix.

**Diagnose:**

```sh
journalctl -u alloy | grep "Unable to refresh"
docker network ls -q | xargs -n1 docker network inspect \
  --format '{{.Name}} {{range .IPAM.Config}}{{.Gateway}} {{end}}'
```

Any gateway printed with a `/nn` suffix is the offender.

**Fix** — recreate that network with a bare gateway address:

```sh
docker network create --ipv6 \
  --subnet <v4-subnet>  --gateway <v4-gateway> \
  --subnet <v6-subnet>  --gateway <v6-gateway-without-prefix> \
  <network-name>
```

Note this stops and reattaches every container on that network. If it is
Coolify's own network, that includes the Traefik proxy terminating public
traffic, so it is a brief interruption and wants scheduling.

**Why no workaround is shipped instead:** tailing
`/var/lib/docker/containers/*/*-json.log` with `loki.source.file` sidesteps Docker
SD entirely, but the only identity available in that path is the container **ID**,
which changes on every deploy. That reintroduces the exact unbounded-label bug the
next section exists to prevent.

## Logs: what ships, and what does not

An allowlist, for bill control — the same reasoning behind the agent-server host
filtering journald to a single `SyslogIdentifier`.

**Ships:** any container carrying a `com.docker.compose.service` label (`app`,
`seaweedfs`, `postgres`) plus Coolify's own stack (`coolify`, `coolify-db`,
`coolify-proxy`, `coolify-realtime`, `coolify-redis`, `coolify-sentinel`).
`coolify-proxy` is Traefik, and it is the only place a request that never reached
`app` is visible at all; `coolify` itself is where a failed deploy explains
itself.

**Dropped:** anything else on the daemon. A shared box may well run containers
belonging to unrelated projects, and a bare `docker run` has no service identity
worth indexing — if it is worth shipping, give it a compose service name.

### The label that matters: `service_name`, never the container name

Coolify names containers `<service>-<projectId>-<deployId>`. **The trailing id
changes on every deploy.**

Labelling Loki streams by container name would therefore mint a brand-new stream
per deploy, forever: an index that grows with deploy count rather than log volume,
dashboards that go blank each release, and `{service_name="app"}` matching
nothing. This is the same class of mistake as putting a session id in a label — an
unbounded value used as an index key.

`alloy.alloy` relabels from `com.docker.compose.service` instead, which Coolify
sets from `docker-compose.prod.yml`, is stable across deploys, and has one value
per service.

## Series budget: measure the network interfaces first

Grafana Cloud's free tier allows 10k active series across all hosts. A plain
agent-server host measured **887**. A Docker host can be dramatically more
expensive, and the cause is almost always network interfaces.

Measured on a host with 115 interfaces — one physical NIC, `lo`, `docker0`, **90
`br-*` Docker bridges** and **22 `veth*`** endpoints:

| | samples per scrape |
|---|---|
| node_exporter, unfiltered | **4,325** |
| node_exporter, with the filters in `alloy.alloy` | **376** |

`netdev` and `netclass` emit roughly 27 series per interface between them, so a
box with a network per container gets expensive fast. Volume is only half the
problem: `veth*` names are generated per container and change whenever one is
recreated — and Coolify recreates containers on every deploy. Those series churn
on each release and never retire, which is the metrics-side form of the
unbounded-label bug above. Hence an **allowlist** (`eth*`, `en*`, `docker0`)
rather than a trim.

Check your own host before trusting either number:

```sh
ip -o link | wc -l
curl -s localhost:12345/metrics | grep prometheus_remote_storage_samples_in_total
```

## Setup

### 1. Install Alloy on the host

Follow Grafana's [install instructions](https://grafana.com/docs/alloy/latest/set-up/install/).
On Debian/Ubuntu this installs an `alloy` systemd unit reading
`/etc/alloy/config.alloy` with environment from `/etc/default/alloy`.

**Then add the `alloy` user to the `docker` group.** The apt package runs Alloy as
`alloy`, not root, and both `discovery.docker` and `loki.source.docker` need to
read `/var/run/docker.sock`:

```sh
usermod -aG docker alloy
systemctl restart alloy
```

Skipping this is a quiet failure: the metrics pipelines keep working, the service
reports healthy, and only Alloy's own log says the Docker components are erroring.

`alloy.alloy` targets **Alloy 1.x** — it uses `sys.env()`, which the older Grafana
Agent (Flow mode / River) spelled `env()`.

### 2. Configure

```sh
cp observability/coolify-host/alloy.alloy /etc/alloy/config.alloy
install -m 0600 /dev/null /etc/default/alloy   # then fill it in — it holds tokens
alloy validate /etc/alloy/config.alloy
systemctl restart alloy
```

Copy `alloy.env.example` into `/etc/default/alloy` and fill in the values. Set
`COOLIFY_INSTANCE` **explicitly** — leaving it to the hostname gives you whatever
the image was named, which says nothing about what the box does and changes on a
rebuild, silently splitting every dashboard and saved query at that moment.

### 3. ⚠️ Nothing syncs this file onto the box

The agent-server host has a deploy workflow that SSHes in and syncs its Alloy
config on every deploy, validating it and rolling back if Alloy will not reload.
**There is no equivalent here.** Coolify deploys from a git webhook and never runs
a script of ours, so there is no hook to hang a sync on.

The consequence: `/etc/alloy/config.alloy` and this repo's copy can silently
diverge, indefinitely. That is a failure this project has already had once, on the
other host — a systemd unit hand-copied once, never synced again, drifted for
months, and nobody knew because nothing was broken.

Until a sync exists: **change the repo copy and re-copy it in the same sitting**,
and treat a change to `alloy.alloy` as incomplete until `alloy validate` has run
on the box. If you find yourself editing `/etc/alloy/config.alloy` directly, stop
and port the change back.

### 4. Redeploy for the SeaweedFS metrics port

The `-metricsPort` change lives in `docker-compose.prod.yml`, so it takes effect
only when Coolify redeploys the stack and recreates the `seaweedfs` container.
Until then `up{job="seaweedfs"}` stays 0 and the disk alert sits in `NoData` —
correct and self-describing.

Verify after the redeploy, from the host:

```sh
curl -s http://127.0.0.1:9327/metrics | grep SeaweedFS_volumeServer_resource
```

Four lines back (`all`, `avail`, `free`, `used`) means the endpoint is live.

## Correlating across hosts

Both host configs use the same three labels, which is what makes this work:

- `env` — set it to the same value on every host in a deployment
- `instance` — one stable, human-recognisable value per host
- `job` — `integrations/node_exporter` on **both** for host metrics, so one
  prebuilt Grafana dashboard covers every host, switchable by `instance`;
  service-specific for everything else (`maskin-agent-server`, `maskin-coolify`,
  `seaweedfs`)

A worked pivot — a session that misbehaved around a storage problem:

```logql
# 1. What was SeaweedFS doing?
{instance="$app_host", service_name="seaweedfs"}

# 2. What did the app say at the same instant?
{instance="$app_host", service_name="app"} |= "agent-storage"

# 3. And what did the agent-server host see for that session?
{instance="$agent_host", job="maskin-agent-server"} | session_id="<id>"
```

```promql
# Disk headroom on the SeaweedFS volume, as the alert computes it
min by (instance, name) (SeaweedFS_volumeServer_resource{type="avail"})
  / min by (instance, name) (SeaweedFS_volumeServer_resource{type="all"})

# Every host's CPU on one panel
1 - rate(node_cpu_seconds_total{mode="idle", env="production"}[5m])
```

## What this does *not* cover

- **Per-container resource usage.** node_exporter measures the whole machine, so
  a CPU spike shows up but not *which container* caused it. cAdvisor
  (`prometheus.exporter.cadvisor`) is the answer and is deliberately deferred: its
  cardinality scales with container count, which on a Docker host is exactly the
  thing that gets expensive. Add it when there is a question that needs it, and
  measure the series count before and after.
- **Postgres.** No `postgres_exporter` is wired up here, because whether the
  compose `postgres` service is the real database depends on the deployment — a
  managed provider set via `DATABASE_URL` leaves it running but unused. Exporting
  an unused database produces a permanently-green dashboard that invites someone
  mid-incident to conclude the database is fine, which is worse than no dashboard.
  If the compose Postgres *is* your production database, adding
  `prometheus.exporter.postgres` here is the right move; if it is not, monitor it
  where it actually runs.
- **Traefik's own metrics.** `coolify-proxy` can expose a Prometheus endpoint,
  which would give request rates and status-code breakdowns for everything behind
  it. Its logs ship today; its metrics do not. Enabling that means changing
  Coolify's own proxy configuration, which Coolify overwrites on upgrade — worth
  doing, but as its own piece of work with that caveat handled.
- **Alerting on anything but SeaweedFS disk.** Host CPU/memory/disk are
  dashboards, not pages, on purpose — see the equivalent discussion in the
  agent-server README.

## Verifying which host serves production

A method note, because getting this wrong is how you end up with a green
dashboard over an uncovered machine.

`docker ps` answers "are these containers running", which is not the same
question. A Coolify stack can be installed and running on a box that deploys
nothing at all. Ask the control plane what it has actually deployed:

```sh
docker exec coolify-db psql -U coolify -d coolify \
  -c 'select count(*) from applications' \
  -c 'select count(*) from application_deployment_queues' \
  -c 'select id, name, ip from servers'
curl -s http://127.0.0.1:8080/api/http/routers   # Traefik: what is actually routed
```

Zero applications and zero configured routers means that install serves nothing,
however healthy its containers look. Note also that Coolify installs a
**sentinel** container on remote servers it manages, so `coolify-sentinel` on a
box is not by itself evidence that the box runs Coolify — check the `servers`
table to see which install claims it.
