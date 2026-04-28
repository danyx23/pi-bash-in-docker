---
name: docker-container-lifecycle
description: Start, stop, inspect, and use the Docker container targeted by the pi-bash-in-docker extension. Use when the user wants to run Pi on the host but execute bash commands inside a long-running Docker container, including dev servers and background processes.
---

# Docker Container Lifecycle for Pi Bash-in-Docker

Use this skill to help the user create, start, stop, inspect, and use the Docker container that Pi bash commands run inside.

This skill assumes Pi itself runs on the host and the `pi-bash-in-docker` extension routes bash/tool commands into Docker.

## Extension Basics

If this package is installed, flags are optional when the project has `.pi/bash-in-docker.json` or when a running default container named `pi-tools` exists.

Recommended project config:

```json
{
  "container": "pi-tools",
  "containerCwd": "/workspace",
  "shell": "sh",
  "check": true,
  "autoStart": true
}
```

With that config, run:

```bash
pi
```

The extension decides whether to enable Docker bash during Pi session startup. If project config or the container is created from inside an already-running Pi session, restart Pi or use `/docker-start` before expecting Pi `bash` tool calls and user `!` commands to route into Docker.

For use without project config, start Pi with explicit Docker flags:

```bash
pi \
  --docker-container pi-tools \
  --docker-cwd /workspace \
  --docker-check
```

Important flags:

```text
--docker-container <name-or-id>   Container used for bash execution
--docker-cwd <path>               Container path corresponding to host cwd, default /workspace
--docker-local-cwd <path>         Host path corresponding to docker-cwd, default current cwd
--docker-shell <shell>            Shell in container, default sh
--docker-user <user-or-uid>       Optional docker exec -u user
--docker-env KEY=VALUE,...        Optional env passed to docker exec
--docker-check                    Validate container/cwd on startup
--docker-auto-start               Start stopped configured container on session start
```

The extension also provides a host-side agent tool and slash commands:

```text
docker_rebuild_restart
/docker-status
/docker-start [container]
/docker-stop [container]
/docker-doctor
```

Use `docker_rebuild_restart` after Dockerfile/compose changes when a Compose-managed Pi Docker container must be rebuilt and recreated from the host Pi process. This is different from the routed bash tool and can work even when `docker` is not installed inside the container.

## Recommended Container Shape

For an existing Dockerfile:

```bash
docker build -t pi-tools-image .
```

Create a persistent dev container:

```bash
docker run -d \
  --init \
  --name pi-tools \
  -v "$PWD":/workspace \
  -w /workspace \
  -p 3000:3000 \
  pi-tools-image \
  sleep infinity
```

Create project config so future Pi starts need no flags:

```bash
mkdir -p .pi
cat > .pi/bash-in-docker.json <<'JSON'
{
  "container": "pi-tools",
  "containerCwd": "/workspace",
  "shell": "sh",
  "check": true,
  "autoStart": true
}
JSON
```

Adjust ports for the project:

- Vite: `5173:5173`
- Next.js/Node: `3000:3000`
- Django/FastAPI/Flask: `8000:8000`
- Spring/other JVM: `8080:8080`

Use `--init` so background processes are reaped properly.

## Start/Stop Commands

Start an existing stopped container:

```bash
docker start pi-tools
```

Stop it:

```bash
docker stop pi-tools
```

Remove and recreate it if needed:

```bash
docker rm pi-tools
```

Check status:

```bash
docker ps --filter name=pi-tools
```

Inside Pi, prefer extension slash commands when available:

```text
/docker-status
/docker-doctor
/docker-start
/docker-stop
```

## Compose Alternative

If the project has `compose.yaml`:

```yaml
services:
  pi-tools:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: pi-tools
    init: true
    stdin_open: true
    tty: true
    working_dir: /workspace
    volumes:
      - .:/workspace
    ports:
      - "3000:3000"
    security_opt:
      - no-new-privileges:true
    command: sleep infinity
```

Start:

```bash
docker compose up -d pi-tools
```

Find the actual container name/id:

```bash
docker compose ps -q pi-tools
```

Then create `.pi/bash-in-docker.json` as shown above and start Pi normally:

```bash
pi
```

For use without project config, start Pi with explicit Docker flags:

```bash
pi \
  --docker-container "$(docker compose ps -q pi-tools)" \
  --docker-cwd /workspace \
  --docker-check
```

## Verify Bash Routing

After starting Pi with the extension, look for the `Docker: <container>:/workspace` status item or a startup notification like `Docker bash enabled ...`.

Then run inside Pi:

```bash
/docker-status
/docker-doctor
!pwd
!uname -a
!id
!ls -la
```

Expected:

- `pwd` should be `/workspace` or a subdirectory under it.
- `uname -a` should report Linux.
- files should match the host project checkout because it is bind-mounted.

If `uname -s` or `uname -a` reports Darwin/macOS, the command is not running through the extension-routed Pi bash tool. Common causes:

- Pi was started before `.pi/bash-in-docker.json` existed or before the container was running;
- Pi was started from a directory that does not contain the project's `.pi/bash-in-docker.json`;
- the package is not installed/enabled, or Pi was started with `--no-extensions`;
- the command was run in an external terminal/API harness instead of Pi's `bash` tool or user `!` command.

Test write visibility:

```bash
!echo hello-from-container > .pi-docker-test
```

Then verify the file exists on the host project directory.

## Background Dev Servers

A bash command that never returns will block the Pi tool call. Start servers in the background and return immediately.

Use this pattern:

```bash
mkdir -p /tmp/pi-bg
nohup npm run dev -- --host 0.0.0.0 > /tmp/pi-bg/dev.log 2>&1 < /dev/null &
echo $! > /tmp/pi-bg/dev.pid
```

For Python/FastAPI:

```bash
mkdir -p /tmp/pi-bg
nohup uvicorn app:app --host 0.0.0.0 --port 8000 > /tmp/pi-bg/dev.log 2>&1 < /dev/null &
echo $! > /tmp/pi-bg/dev.pid
```

Inspect logs:

```bash
tail -n 100 /tmp/pi-bg/dev.log
```

Stop the server:

```bash
kill "$(cat /tmp/pi-bg/dev.pid)"
```

If the process ignores SIGTERM:

```bash
kill -9 "$(cat /tmp/pi-bg/dev.pid)"
```

Important:

- redirect stdin: `< /dev/null`
- redirect stdout/stderr to a log file
- bind web servers to `0.0.0.0`
- publish ports when creating the container

## Troubleshooting

Container not found:

```bash
docker ps -a
```

Container is stopped:

```bash
docker start pi-tools
```

Container cwd missing:

```bash
docker exec pi-tools test -d /workspace
```

Docker exec check:

```bash
docker exec -i -w /workspace pi-tools sh -lc 'pwd && id && uname -a'
```

Port not reachable from host:

- container must have been created with `-p host:container`
- server must bind `0.0.0.0`
- check logs in `/tmp/pi-bg/dev.log`

## Final Response

When helping the user, include:

- container/image name;
- exact `docker build` and `docker run` or `docker compose up` commands;
- `.pi/bash-in-docker.json` contents when used;
- exact Pi invocation; prefer plain `pi` after install/config, otherwise include extension flags;
- dev server URL if applicable;
- commands to inspect logs and stop background processes.
