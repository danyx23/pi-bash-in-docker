# pi-bash-in-docker

Pi package that keeps Pi running on the host while routing `bash` tool calls and user `!` commands into a Docker container.

This is useful on macOS when you want native host integrations such as Glimpse, but you want builds/tests/dev commands to run in Linux/Docker.

## Install / Use Locally

Try it without installing:

```bash
pi -e ~/pi-bash-in-docker \
  --docker-container pi-tools \
  --docker-cwd /workspace \
  --docker-check
```

Install as a local package:

```bash
pi install ~/pi-bash-in-docker
```

After installation, flags are optional. The extension will:

1. read project config from `.pi/bash-in-docker.json` or `.pi/docker-bash.json` when present;
2. otherwise use `PI_DOCKER_*` environment variables when present;
3. otherwise quietly use the default container name `pi-tools` if that container exists and is running.

With a project config or a running `pi-tools` container, simply start Pi normally:

```bash
pi
```

The extension reads project config and decides whether to enable Docker bash at Pi session startup. If you create `.pi/bash-in-docker.json`, create/start the container, or change Docker flags from inside an already-running Pi session, start a new Pi session (or use `/docker-start`) before expecting `bash` tool calls and `!` commands to route into Docker.

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

- Pi was started before `.pi/bash-in-docker.json` existed or before the container was running;
- Pi was started from a different directory than the project root containing `.pi/bash-in-docker.json`;
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

Create `.pi/bash-in-docker.json` in a project to make all flags optional:

```json
{
  "container": "pi-tools",
  "containerCwd": "/workspace",
  "shell": "sh",
  "check": true,
  "autoStart": true
}
```

`autoStart: true` lets the extension start an existing stopped container on Pi startup. If the container does not exist, create it with `docker run` or compose first.

## Flags

Flags override project config:

```text
--docker-container <name-or-id>   Container for Docker bash routing (default: pi-tools when present)
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

`docker_rebuild_restart` runs from the host Pi process, not from inside the Docker-routed bash tool. Use it after changing a Dockerfile or compose setup when the image must be rebuilt and the configured container recreated. It requires a Compose file and runs the host equivalent of:

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
