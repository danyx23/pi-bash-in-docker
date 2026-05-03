# pi-bash-in-docker

A public Pi extension that keeps Pi running on the host while routing Pi's `bash` tool calls and user `!` commands into a Docker container.

This is useful on macOS when you want native host integrations such as Glimpse, but want builds, tests, package installs, and dev commands to run in Linux/Docker.

## Install

Install the extension from GitHub:

```bash
pi install https://github.com/danyx23/pi-bash-in-docker
```

Then start Pi normally from a project that has Docker bash configured:

```bash
pi
```

The extension enables Docker routing at Pi session startup only when Docker mode is explicitly configured. If you create `.pi/pi-bash-in-docker/config.json`, create/start the container, or change Docker settings inside an already-running Pi session, start a new Pi session or use `/docker-start` before expecting `bash` tool calls and `!` commands to route into Docker.

## How Activation Works

The extension stays inert by default so it can coexist with other extensions that override `bash`, such as `pi-ssh`.

It activates only when one of these explicit configuration sources exists:

1. `--docker-container <name-or-id>` CLI flag;
2. project config at `.pi/pi-bash-in-docker/config.json`;
   - legacy `.pi/bash-in-docker.json` and `.pi/docker-bash.json` files are still read for compatibility;
3. `PI_DOCKER_CONTAINER` environment variable.

With project config, plain `pi` is enough. Without one of those activation sources, the extension does not override Pi's built-in `bash` tool.

## Quick Project Setup

Inside Pi, use the included setup skill:

```text
/skill:docker-init
```

It can create or improve Dockerfile, `.dockerignore`, Compose setup, and `.pi/pi-bash-in-docker/config.json` so future sessions work without flags. The setup skill can place the Docker files either at the project root or under `.pi/pi-bash-in-docker/` for easy gitignore/local-dev isolation.

## Verify Activation

When Docker bash is active, Pi shows a `Docker: <container>:/workspace` status item and a startup notification like `Docker bash enabled ...`.

Inside Pi, verify routing with:

```bash
!uname -s
!pwd
!id
```

Expected:

```text
Linux
/workspace
```

If `uname -s` returns `Darwin`, that command is running on macOS, not in the Docker-routed Pi bash tool. Common causes:

- Pi was started before `.pi/pi-bash-in-docker/config.json` existed or before the container was running;
- Pi was started from a different directory than the project root containing `.pi/pi-bash-in-docker/config.json`;
- the command was run in an external terminal/API harness instead of Pi's `bash` tool or user `!` command;
- the package was not installed/enabled, or Pi was started with `--no-extensions`.

Use `/docker-status` and `/docker-doctor` inside Pi for diagnostics.

## Recommended Container

```bash
docker build -t pi-tools-image .

docker run -d \
  --init \
  --name pi-tools \
  -v "$PWD":/workspace \
  -w /workspace \
  -p 3000:3000 \
  pi-tools-image \
  sleep infinity
```

## Project Config

Create `.pi/pi-bash-in-docker/config.json` in a project to make flags optional:

```json
{
  "container": "pi-tools",
  "containerCwd": "/workspace",
  "shell": "sh",
  "check": true,
  "autoStart": true
}
```

`autoStart: true` lets the extension start an existing stopped container on Pi startup. If the container does not exist, create it with `docker run` or Compose first.

## Flags

Flags override project config:

```text
--docker-container <name-or-id>   Activate Docker bash routing for this container
--docker-cwd <path>               Container cwd corresponding to host cwd, default /workspace
--docker-local-cwd <path>         Host cwd corresponding to docker-cwd, default process.cwd()
--docker-shell <shell>            Shell inside the container, default sh
--docker-user <user-or-uid>       Optional docker exec -u value
--docker-env KEY=VALUE,...        Optional env entries for docker exec
--docker-check                    Validate container/cwd on session start
--docker-auto-start               Start stopped configured container on session start
```

Environment variable equivalents: `PI_DOCKER_CONTAINER`, `PI_DOCKER_CWD`, `PI_DOCKER_LOCAL_CWD`, `PI_DOCKER_SHELL`, `PI_DOCKER_USER`, `PI_DOCKER_ENV`, `PI_DOCKER_CHECK`, `PI_DOCKER_AUTO_START`.

## Agent Tools

The extension overrides Pi's built-in `bash` tool so bash commands run through `docker exec` when Docker bash is enabled.

It also registers:

```text
docker_rebuild_restart
```

`docker_rebuild_restart` runs from the host Pi process, not from inside the Docker-routed bash tool. Use it after changing a Dockerfile or Compose setup when the image must be rebuilt and the configured container recreated. It looks for Compose files at the project root and under `.pi/pi-bash-in-docker/`, then runs the host equivalent of:

```bash
docker compose build <service>
docker compose up -d --force-recreate <service>
```

The tool asks for confirmation before rebuilding/recreating because it can stop running processes in the container.

## Slash Commands

```text
/docker-status
/docker-start [container]
/docker-stop [container]
/docker-doctor
```

## Skills

This package includes three skills:

- `docker-init` — initialize a project for pi-bash-in-docker, including Dockerfile, `.dockerignore`, Compose, project config, and optional host Git/SSH identity sharing.
- `docker-container-lifecycle` — start/stop/inspect the target container and manage background dev servers.
- `docker-tool-install` — add missing binaries/tools/software to the Dockerfile and guide image rebuild/container recreate.

Use explicitly with:

```text
/skill:docker-init
/skill:docker-container-lifecycle
/skill:docker-tool-install
```

## Notes

- Pi itself remains a host process; only Pi's `bash` tool and user `!` commands are routed through `docker exec`.
- `read`, `edit`, and `write` remain host filesystem operations.
- External shells, terminal commands, and non-Pi harness tools are not affected by this extension.
- The project must be bind-mounted into the container at `--docker-cwd`.
- Long-running servers should be started with `nohup`/`setsid` and redirected stdio so the bash call returns.
