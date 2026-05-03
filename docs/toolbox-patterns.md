# Patterns from `~/code/toolbox` Worth Considering

Investigated: `~/code/toolbox`

## Summary

`toolbox` is a mature Docker-based local-agent environment. Its core model is almost the inverse of this extension's first goal:

- toolbox runs the agent CLIs *inside* Docker;
- `pi-bash-in-docker` should run Pi on the host and route only bash into Docker.

Even so, toolbox has several useful patterns we should consider as optional extras or design inspiration.

## High-Value Patterns

### 1. Long-running service container

Toolbox runs the main container as a persistent service:

```yaml
services:
  toolbox:
    init: true
    stdin_open: true
    tty: true
    working_dir: /workspace
    command: sleep infinity
```

This matches our desired execution model:

- start the container once;
- run repeated commands with `docker exec`;
- avoid per-command container startup cost;
- allow background processes and dev servers to remain alive between invocations.

**Recommendation:** Document `sleep infinity` + `init: true` as the recommended container shape. Optionally add a `doctor` check that warns when the target container was not started with init.

### 2. Deterministic project identity

Toolbox portable mode computes:

- project basename;
- sanitized slug;
- short hash from absolute project path;
- deterministic compose project name.

Example from `scripts/toolbox-portable.sh`:

```bash
PROJECT_HASH="$(printf '%s' "$PROJECT_DIR" | shasum -a 1 | awk '{print $1}' | cut -c1-10)"
PROJECT_SLUG="$(sanitize "$PROJECT_BASENAME")"
COMPOSE_PROJECT="toolbox-${PROJECT_SLUG}-${PROJECT_HASH}"
```

**Why it matters for us:** If we add auto-container management, deterministic names avoid collisions and make it possible to infer the right container from the current project.

Possible convention:

```text
pi-bash-<project-slug>-<hash>
```

Optional flags:

```text
--docker-auto-name
--docker-project-dir <path>
```

### 3. Portable mode with per-project config

Toolbox supports a global `tb` command that can be run from any project. It stores project defaults in:

```text
.toolbox/tb.env
```

It supports one-time interactive setup and then simple daily usage.

**Possible equivalent for us:** A small helper command later, e.g.:

```bash
pi-docker init
pi-docker up
pi-docker env
```

or an extension command:

```text
/docker-init
/docker-env
```

For v1 this is probably out of scope, but the pattern is valuable.

### 4. Project vs global state scope

Toolbox allows state scope selection:

```text
project: ~/.toolbox/projects/<hash>/...
global:  ~/.claude, ~/.codex, ~/.pi, etc.
```

For our current design, Pi state remains on the host, so we do not need this for Pi itself. But if the extension later manages containers, we might want project-scoped runtime directories for:

- container shell history;
- logs for background processes;
- generated compose files;
- optional per-project env/config.

Potential path:

```text
~/.pi-bash-in-docker/projects/<hash>/
```

or project-local:

```text
.pi/pi-bash-in-docker/config.json
.pi/docker-bash.env
```

### 5. Compose overlays / profiles

Toolbox has separate overlay compose files:

```text
compose.shared.yaml
compose.socket-proxy.yaml
compose.agent-browser.yaml
compose.portable.shared.yaml
compose.portable.socket-proxy.yaml
compose.portable.agent-browser.yaml
```

The selected profile controls which services start:

```text
base          -> toolbox only
socket-proxy  -> toolbox + socket-proxy
agent-browser -> toolbox + socket-proxy + agent-browser
```

**Possible equivalent for us:** If we add container creation/management, support profiles:

```text
base          -> target command container only
socket-proxy  -> target command container + Docker socket proxy
dev-browser   -> target command container + browser sidecar
```

This should be a future optional feature, not part of the first extension.

### 6. Restricted Docker socket proxy

Toolbox avoids mounting the Docker socket directly into the agent container. Instead it uses:

```yaml
socket-proxy:
  image: lscr.io/linuxserver/socket-proxy:latest
  environment:
    - CONTAINERS=1
    - EXEC=1
    - POST=1
    - INFO=1
    - PING=1
    - VERSION=1
    - EVENTS=1
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
```

Then the toolbox container gets:

```text
DOCKER_HOST=tcp://socket-proxy:2375
```

**Relevance:** Our extension runs on the host and calls host `docker`, so it does not need this for basic operation. However, commands executed *inside* the target container might need Docker access, e.g. integration tests that run Docker.

Optional future mode:

- create/join a compose stack with `socket-proxy`;
- pass `DOCKER_HOST=tcp://socket-proxy:2375` into the command container;
- allow nested Docker operations with limited API permissions.

This is safer than mounting `/var/run/docker.sock` directly into the target container.

### 7. Label-based container discovery

The agent-browser wrapper finds sidecar containers by Docker Compose labels:

```bash
docker ps -q \
  --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
  --filter "label=com.docker.compose.service=agent-browser" \
  | head -n1
```

Fallback uses ambient compose:

```bash
docker compose ps -q agent-browser
```

**Recommendation:** Add optional discovery modes:

```text
--docker-container <name-or-id>              explicit, v1
--docker-compose-service <service>          use compose service
--docker-compose-project <project>          discover by labels
--docker-compose-file <file>                compose exec / up support
```

This would let users target Toolbox-style containers without manually finding the generated container name.

### 8. `ensure_up` pattern

Toolbox has an `ensure_up` function that initializes dirs and runs compose before opening shell/tmux/agent commands.

**For our extension:** Optional `--docker-ensure-up` could:

- check whether a compose service/container is running;
- run `docker compose up -d <service>` if needed;
- then execute bash in it.

This would address the usability gap between “the extension can exec into a running container” and “the extension can manage the container lifecycle.”

### 9. Mount writability diagnostics

Toolbox's entrypoint checks bind-mounted state dirs for writability and emits a clear error if Docker created them as root.

**For us:** A startup `doctor` check could validate:

- Docker CLI is available;
- Docker daemon is reachable;
- target container exists;
- target container is running;
- container cwd exists;
- host cwd maps to container cwd;
- a test write in the host cwd is visible in the container, if enabled;
- optional port publishing checks for common dev server ports.

Potential flag:

```text
--docker-check
```

or command:

```text
/docker-doctor
```

### 10. Non-root runtime user and security options

Toolbox runs as a non-root user (`sandboxuser`) and sets:

```yaml
security_opt:
  - no-new-privileges:true
```

**For our docs:** Recommend non-root containers when possible. Also consider a `--docker-user` option for `docker exec -u`.

Potential flag:

```text
--docker-user <user-or-uid>
```

### 11. Resource limits

Toolbox sets resource limits:

```yaml
limits:
  cpus: '1'
  memory: 4G
```

**For us:** If we generate compose/container definitions later, include optional resource limits. If users provide their own container, just document this as a recommended practice.

### 12. Persistent shell history

Toolbox mounts a command history volume to `/commandhistory` and sets `HISTFILE`.

Our agent bash calls are non-interactive, so this is less important. But if we later support interactive `docker exec -it` or shell/tmux attachment, persistent history becomes useful.

### 13. Tmux attach workflow

Toolbox provides host recipes to attach to a tmux session inside the container:

```bash
docker compose exec -it toolbox tmux -L "$WORKSPACE_NAME" attach
```

**Possible optional extra:** provide a command that opens an interactive shell/tmux in the same container used by Pi bash:

```text
/docker-shell
/docker-tmux
```

This complements non-interactive bash tool calls.

### 14. Sidecar service pattern

Toolbox's agent-browser is a sidecar accessed by wrapper script via `docker exec` into another container.

**Potential future extra:** Generic sidecar execution support, e.g. browser automation, databases, or test services. Probably out of scope for v1.

## Features to Consider for `pi-bash-in-docker`

### V1 / Near-term

- Explicit running-container target:
  - `--docker-container`
  - `--docker-cwd`
  - `--docker-shell`
- `docker exec`-based `BashOperations`.
- Route `user_bash` as well as agent bash tool calls.
- Cwd mapping from host path to container path.
- Startup validation with helpful errors.
- System prompt note that bash runs in Docker and files are bind-mounted.

### Optional V1.5

- `--docker-check` / `/docker-doctor`.
- `--docker-user`.
- `--docker-env KEY=VALUE`.
- `--docker-auto-start` for stopped explicit containers.
- Background process helper docs and maybe helper commands:
  - `/docker-bg-start`
  - `/docker-bg-stop`
  - `/docker-bg-logs`

### V2

- Docker Compose support:
  - `--docker-compose-file`
  - `--docker-compose-project`
  - `--docker-compose-service`
  - `--docker-ensure-up`
- Compose-label container discovery.
- Deterministic auto-container naming from project path.
- Optional generated compose profile.
- Socket-proxy profile for limited Docker access inside the target container.
- Interactive shell/tmux attach command.

## Concrete Toolbox Compatibility Idea

Because toolbox containers use `/workspace` and service name `toolbox`, we can make our extension work well with toolbox-managed containers by supporting either:

```bash
pi -e ~/pi-bash-in-docker/src/index.ts \
  --docker-container <actual-container-name-or-id> \
  --docker-cwd /workspace
```

or, later:

```bash
pi -e ~/pi-bash-in-docker/src/index.ts \
  --docker-compose-project toolbox-myproj-abc123 \
  --docker-compose-service toolbox \
  --docker-cwd /workspace
```

The latter could discover the container using Compose labels, mirroring the agent-browser wrapper.

## Main Takeaway

For the first implementation, stay simple: explicit running container + `docker exec`.

But toolbox suggests a clear path for optional extras:

1. validation/doctor;
2. compose service discovery;
3. ensure-up lifecycle;
4. project-scoped config/state;
5. socket-proxy for safer nested Docker;
6. interactive shell/tmux convenience commands.
