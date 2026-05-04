# pi-bash-in-docker

A Pi extension that keeps Pi running on the host while routing Pi's `bash` tool calls and user `!` commands into a Docker container.

This is useful when you want native host integrations for pi extensions such as Glimpse, which don't work too well if you run pi itself inside a docker container. Because pi uses only 4 tools (read, write, edit, bash), redirecting bash to run inside a docker container while running pi on the host gives you sandboxing of all programs that are executed via bash (builds, tests, ad-hoc scripts, ...), while at the same time allowing extensions to run on the host and all session logs to remain there as well.

[Gondolin](https://earendil-works.github.io/gondolin/cli/) is another interesting sandboxing alternative that supports a similar idea and integrates with pi. It uses QEMU as a micro-vm and has really powerful control over http (e.g. you can do secret injection from the host which can be really nice), but, at the time of writing, it only support HTTP traffic. If you want to be able to do full outgoing network traffic, or if you like the familiarity of docker, pi-bash-in-docker is a good choice; if you want a more lightweight virtualization, control http traffic in detail, or have more control over mapped files etc in the sandbox, give gondolin a try.

This extension is used by myself but otherwise still experimental. Give it a spin and let me know if works for you or how it could be improved.

## Install

Install the extension from GitHub:

```bash
pi install https://github.com/danyx23/pi-bash-in-docker
```

Then start Pi

```bash
pi
```

If you use the default statusline, you will see a new line at the bottom that says "Bash: host". This tells you that currently, bash commands by pi will run on the host and not be sandboxed. To set up the docker container, use the init skill:

```text
/skill:docker-init
```

It can re-use an existing development docker setup (like a VS Code devcontainer setup), or create a new Dockerfile, `.dockerignore`, and Docker Compose setup.

In both cases, it will write a new `.pi/pi-bash-in-docker/config.json` so future sessions work without flags. The setup skill can place the Docker files either at the project root or under `.pi/pi-bash-in-docker/` for easy gitignore/local-dev isolation.

Once the configuration is complete (or the next time you start a new `pi` session) use the `/docker-start` command or the `/skill:docker-container-lifecycle` skill to fire up the docker container. Once this is running, the status line should tell you that and show something like "Bash: docker PROJECT:/workspace ● running".

`Bash` tool calls and `!` commands will now execute inside the docker container. You can try it with

```bash
!uname -s
```
which should print linux even when on a darwin host.

If `uname -s` returns `Darwin`, that command is running on macOS, not in the Docker-routed Pi bash tool. Common causes:

- Pi was started before `.pi/pi-bash-in-docker/config.json` existed or before the container was running;
- Pi was started from a different directory than the project root containing `.pi/pi-bash-in-docker/config.json`;
- the command was run in an external terminal/API harness instead of Pi's `bash` tool or user `!` command;
- the package was not installed/enabled, or Pi was started with `--no-extensions`.

Use `/docker-status` and `/docker-doctor` inside Pi for diagnostics.

## How Activation Works

The extension stays inert by default so it can coexist with other extensions that override `bash`, such as `pi-ssh`.

It activates only when one of these explicit configuration sources exists:

1. `--docker-container <name-or-id>` CLI flag;
2. project config at `.pi/pi-bash-in-docker/config.json`;
   - legacy `.pi/bash-in-docker.json` and `.pi/docker-bash.json` files are still read for compatibility;
3. `PI_DOCKER_CONTAINER` environment variable.

With project config, plain `pi` is enough. Without one of those activation sources, the extension does not override Pi's built-in `bash` tool.

## Project Config

Create `.pi/pi-bash-in-docker/config.json` in a project to make flags optional (or have the `/skill:docker-init` create if for you after asking you a few questions).

```json
{
  "container": "pi-tools",
  "containerCwd": "/workspace",
  "shell": "sh",
  "check": true,
  "autoStart": true,
  "stopOnLastExit": false,
  "composeFile": ".pi/pi-bash-in-docker/compose.yaml",
  "composeService": "pi-tools"
}
```

`user` is optional and is passed to `docker exec --user`/`-u`. It accepts the same values Docker accepts, such as `node`, `1000`, `1000:1000`, or `node:node`. Set it when your devcontainer mounts Git/SSH config, caches, or generated files for a non-root user.

`env` is optional and is passed to `docker exec -e`. Use it for execution-time variables such as `SSH_AUTH_SOCK=/ssh-agent` when the container was created with a matching socket mount.

`autoStart: true` lets the extension start an existing stopped container on Pi startup. If the container does not exist, create it with `docker run` or Compose first.

`composeFile` and `composeService` are optional but recommended for Compose-managed containers, especially when the file has a non-standard name such as `docker-compose.devcontainer.yml`. `composeFile` is resolved relative to the project root where Pi is started. The rebuild/restart tool and `stopOnLastExit` use these values instead of guessing.

`stopOnLastExit: true` makes the extension record active Pi process IDs in `.pi/pi-bash-in-docker/processes.json`. On Pi quit, it removes the current PID, prunes stale PIDs, and if no other live Pi process is using the same project config, it stops the Compose service (`docker compose stop <service>`) when a Compose file is configured or discoverable, otherwise it falls back to `docker stop <container>`.

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
--docker-stop-on-last-exit        Stop the container when the last Pi process using this project config exits
```

Environment variable equivalents: `PI_DOCKER_CONTAINER`, `PI_DOCKER_CWD`, `PI_DOCKER_LOCAL_CWD`, `PI_DOCKER_SHELL`, `PI_DOCKER_USER`, `PI_DOCKER_ENV`, `PI_DOCKER_CHECK`, `PI_DOCKER_AUTO_START`, `PI_DOCKER_STOP_ON_LAST_EXIT`.

## SSH Agent Forwarding

The extension can pass `SSH_AUTH_SOCK` into `docker exec`, but it cannot add mounts to an already-created container. Configure the socket mount in Docker Compose or when creating the container.

On macOS Docker Desktop, prefer Docker's host-service SSH agent socket instead of bind-mounting the host `$SSH_AUTH_SOCK` path directly:

```yaml
services:
  pi-tools:
    volumes:
      - .:/workspace
      - /run/host-services/ssh-auth.sock:/ssh-agent
      - ~/.gitconfig:/home/node/.gitconfig:ro
      - ~/.config/git:/home/node/.config/git:ro
      - ~/.ssh/config:/home/node/.ssh/config:ro
      - ~/.ssh/known_hosts:/home/node/.ssh/known_hosts:ro
    environment:
      SSH_AUTH_SOCK: /ssh-agent
```

Then align Pi's Docker exec user and env with the container setup:

```json
{
  "container": "pi-tools",
  "containerCwd": "/workspace",
  "shell": "sh",
  "user": "node",
  "env": ["SSH_AUTH_SOCK=/ssh-agent"],
  "check": true,
  "autoStart": true
}
```

Verify inside Pi with `/docker-doctor` or:

```bash
!whoami
!echo $HOME
!echo $SSH_AUTH_SOCK
!ssh-add -l
!ssh -T git@github.com
```

Adjust `/home/node` and `user` for your image's runtime user. Do not mount all of `~/.ssh` by default; agent forwarding avoids copying private keys, though trusted container processes can still authenticate through the mounted agent while it is available.

## Agent Tools

The extension overrides Pi's built-in `bash` tool so bash commands run through `docker exec` when Docker bash is enabled.

It also registers:

```text
docker_rebuild_restart
```

`docker_rebuild_restart` runs from the host Pi process, not from inside the Docker-routed bash tool. Use it after changing a Dockerfile or Compose setup when the image must be rebuilt and the configured container recreated. It uses `composeFile`/`composeService` from `.pi/pi-bash-in-docker/config.json` when present, otherwise it looks for conventional Compose files at the project root and under `.pi/pi-bash-in-docker/`, then runs the host equivalent of:

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
