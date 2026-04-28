# Microsandbox Backend: Linux/KVM Testing Notes

## Prerequisites

- **Linux with KVM**: Verify with `ls /dev/kvm`
- **microsandbox server**: Must be running and accessible
- **Environment**: Set `RUNTIME_BACKEND=microsandbox`

## Running the Integration Tests

```bash
cd apps/dev
RUNTIME_BACKEND=microsandbox pnpm test:microsandbox
```

Optionally specify a custom test image:
```bash
MICROSANDBOX_TEST_IMAGE=ghcr.io/sindre-ai/agent-base:latest RUNTIME_BACKEND=microsandbox pnpm test:microsandbox
```

## entrypoint.sh Adjustments for MicroVM Compatibility

The following adjustments were made to `docker/agent-base/entrypoint.sh` to ensure it works in both Docker containers and microsandbox microVMs:

### 1. MicroVM Detection

The entrypoint detects whether it's running inside a microsandbox microVM by checking if PID 1 is `sleep infinity` (the base process microsandbox uses to keep the VM alive while running the agent via `execStream`).

### 2. Conditional `chown` for Performance

**Problem**: In Docker, bind mounts often have incorrect ownership (root:root), requiring `chown -R agent:agent /agent`. In microVMs, the `/agent` directory is part of the OCI image filesystem and already has correct ownership from the Dockerfile. Running `chown -R` on a large workspace adds unnecessary startup latency.

**Fix**: In microVMs, only run `chown` if the `/agent` directory is not already owned by the `agent` user. In Docker, always run it (bind mounts require it).

### 3. Privilege Drop Fallback Chain

**Problem**: The original entrypoint used `exec su agent -c 'bash /agent-run.sh'` to drop from root to the `agent` user. While `su` is available in `node:20-slim`, some minimal microVM images may not include it.

**Fix**: Fallback chain: `su` → `runuser` → `setpriv` → run as current user with a warning. The `node:20-slim` base image includes `su`, so this fallback is defensive.

### 4. Host Address (getHostAddress)

The `MicrosandboxBackend.getHostAddress()` returns `172.17.0.1`, which is the default gateway for microsandbox's virtual network. This should be verified on each deployment:

```bash
# From inside the microVM:
ip route | grep default | awk '{print $3}'
```

If the gateway differs from `172.17.0.1`, update the `getHostAddress()` method in `microsandbox-backend.ts` or make it dynamically detect the gateway.

### 5. Signal Handling Differences

| Aspect | Docker | Microsandbox |
|--------|--------|--------------|
| PID 1 | entrypoint.sh | `sleep infinity` |
| Agent process | PID 1 (via `exec`) | Child of `execStream` |
| SIGTERM target | PID 1 → agent | VM stop → kills all |
| Exit detection | Poll `inspect()` | Event-driven `onExit()` |

In Docker, `stop()` sends SIGTERM to PID 1. In microsandbox, `stop()` halts the entire VM — all processes are terminated immediately. The agent should handle SIGTERM gracefully in both cases, but microsandbox provides a harder guarantee of cleanup.

### 6. Volume Mounts

Docker bind mounts (`-v host:guest`) are translated to microsandbox `Mount.bind()` volumes. The `parseBinds()` method handles the conversion:

```
"host/path:/guest/path:rw" → { "/guest/path": Mount.bind("host/path", { readonly: false }) }
```

## Known Limitations

1. **No native snapshots yet**: Pause/resume uses tar-based snapshots (`tar -czf` + `copyFileOut`), same as Docker. Native microsandbox snapshots are not yet available.

2. **Image pull on first boot**: `ensureImage()` is a no-op — microsandbox pulls the OCI image automatically on first `Sandbox.create()`. This means the first session boot is slower. Consider pre-pulling images in production.

3. **Network policies**: In development, the microVM has unrestricted network access. In production, microsandbox's network policies should be configured to restrict outbound traffic (see Phase 5: Secret Management).
