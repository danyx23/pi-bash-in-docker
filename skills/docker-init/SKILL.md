---
name: docker-init
description: Initialize a project for pi-bash-in-docker by creating or improving Dockerfile, .dockerignore, compose setup, project config, and optional host Git/SSH identity sharing. Use when a project lacks containerization, needs a dev-friendly Docker environment for Pi bash commands, or the user asks to set up/init pi-bash-in-docker for a repo.
---

# Docker Init for Pi Bash-in-Docker

Use this skill when the user wants to prepare or initialize a project so Pi can run on the host while bash commands execute inside a Docker container.

This is an initialization/interview skill. It does the previous Dockerfile setup work, but also asks the user about optional development-container features that may be useful now or added in the future.

The goal is a development container, not necessarily the smallest production image. Optimize for the project's runtime and package manager while including practical dev UX niceties inspired by toolbox.

## Initialization Interview

Before writing files, inspect the project and then ask concise setup questions when the answers are not obvious. Do not ask questions whose answers are already explicit in the user's request.

Recommended questions:

1. **Container lifecycle** — “Should I add a Compose file so the Pi Docker container can be started with `docker compose up -d`?”
   - Default recommendation: yes.

2. **Generated Docker file location** — “Should I put the Dockerfile/Compose/Docker ignore files under `.pi/pi-bash-in-docker/` or at the project root?”
   - Default recommendation: `.pi/pi-bash-in-docker/` when these files are only for this extension/dev workflow, because the whole folder is easy to ignore.
   - Recommend project root when the repo can use the Dockerfile/Compose files independently of this extension or wants to share them with the team/CI.
   - Always put the extension config itself at `.pi/pi-bash-in-docker/config.json`.

3. **Container name** — “Use project-specific container name `<suggested>` to avoid conflicts with other projects?”
   - Default recommendation: yes.
   - Use the same name in compose and `.pi/pi-bash-in-docker/config.json`.

4. **Ports** — “Which dev server ports should be published?”
   - Infer likely ports from README/package scripts/framework when possible.
   - Common defaults: Vite `5173`, Node/Next `3000`, Python web `8000`, JVM `8080`.

5. **Host Git/SSH identity sharing** — “Do you want to share your host Git config and SSH agent with the container so `git push` and GitHub SSH auth work inside Docker?”
   - Default recommendation: opt in for trusted personal dev containers; opt out for untrusted repos.
   - Explain the tradeoff briefly:
     - SSH agent forwarding does not copy private keys into the container.
     - Processes in the container can still use the agent socket to authenticate while it is mounted.
     - Git and SSH config should be mounted read-only.
   - If the user says yes, add the compose mounts/environment described in [Optional Host Git/SSH Identity Sharing](#optional-host-gitssh-identity-sharing).

6. **Extra tools** — “Any extra CLIs you want baked into the image now?”
   - If the user names tools, install them persistently in the Dockerfile.
   - For later missing tools, use the `docker-tool-install` skill.

If the user asks for a non-interactive/default setup, choose sensible defaults and mention which optional features were enabled or skipped. Do not enable host Git/SSH identity sharing unless the user explicitly agrees.

## Workflow

1. Inspect the project before writing files.
   - Read `package.json`, lockfiles, `pyproject.toml`, `requirements*.txt`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle`, etc. as applicable.
   - Check whether `Dockerfile`, `.dockerignore`, `compose.yaml`, `docker-compose.yml`, `compose.*.yaml`, or `.pi/pi-bash-in-docker/` Docker files already exist.
   - Check `.pi/pi-bash-in-docker/config.json` and legacy `.pi/bash-in-docker.json` or `.pi/docker-bash.json`.
   - Do not overwrite an existing Dockerfile or compose file without showing the user the intended changes.

2. Choose a base image appropriate for the project.
   - Node: `node:<major>-bookworm` or `node:<major>-bookworm-slim`.
   - Python: `python:<major.minor>-bookworm` or `python:<major.minor>-slim-bookworm`.
   - Go: `golang:<version>-bookworm`.
   - Rust: `rust:<version>-bookworm`.
   - Ruby: `ruby:<version>-bookworm`.
   - Mixed/runtime unknown: prefer Debian bookworm/trixie plus required tools.

3. Include dev UX tools where reasonable.
   Recommended packages:
   - `ca-certificates`, `curl`, `wget`, `git`, `openssh-client`
   - `procps`, `psmisc`, `less`, `vim` or `nano`
   - `ripgrep`, `jq`, `tree`, `tmux`, `fzf`
   - `just` when useful and available, but do not make the build fail if the distro repository lacks it; install it separately or omit it
   - language-specific build deps only when needed

4. Use `/workspace` as the default working directory.

5. Prefer a non-root runtime user when practical.
   - Official language images may already include one, e.g. the Node images include `node` with UID/GID 1000. Prefer using that existing user instead of creating a new UID/GID 1000 user.
   - Creating a group with `groupadd --gid 1000 ...` can fail when that GID already exists.
   Example for images that do not already provide a suitable user:
   ```dockerfile
   ARG USERNAME=sandboxuser
   ARG USER_UID=1000
   ARG USER_GID=1000
   RUN if ! getent group ${USER_GID} >/dev/null; then groupadd --gid ${USER_GID} ${USERNAME}; fi \
       && useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} \
       && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME}
   USER ${USERNAME}
   ```

6. Make the container suitable for long-running `docker exec` usage.
   - The container command can be `sleep infinity` in compose/run docs.
   - Recommend `--init` or `init: true`.
   - The extension will use `docker exec -i -w /workspace [-u <user>] [-e KEY=VALUE] <container> sh -lc '<command>'`.
   - If the image has a non-root runtime user, include that same user in `.pi/pi-bash-in-docker/config.json` as `"user": "<name-or-uid>"` so Pi-created files and `~` match the devcontainer user.

7. Create the Docker build ignore file for the chosen Docker file location.
   - If Docker files live at the project root, create/update root `.dockerignore`.
   - If Docker files live under `.pi/pi-bash-in-docker/`, prefer `.pi/pi-bash-in-docker/Dockerfile.dockerignore` next to that Dockerfile. Because the build context should still be the repo root (`../..` from that folder), the ignore patterns still apply to repo-root paths while keeping extension-dev Docker files easy to ignore.
   Include common heavy/sensitive directories:
   ```text
   .git
   node_modules
   .next
   dist
   build
   coverage
   .venv
   __pycache__
   .pytest_cache
   target
   .env
   .env.*
   .DS_Store
   .toolbox
   ```
   Adjust based on project type. Do not ignore lockfiles.

8. Create project config so the extension works without flags after installation.
   Recommended file: `.pi/pi-bash-in-docker/config.json`
   ```json
   {
     "container": "pi-tools-my-project",
     "containerCwd": "/workspace",
     "shell": "sh",
     "check": true,
     "autoStart": true,
     "stopOnLastExit": false,
     "composeFile": ".pi/pi-bash-in-docker/compose.yaml",
     "composeService": "pi-tools"
   }
   ```
   Create `.pi/pi-bash-in-docker/` if needed. This lets the user run plain `pi` after installing the public package. If the container is Compose-managed, always persist the Compose metadata too:
   - `composeFile`: path to the Compose file relative to the project root where Pi starts, e.g. `compose.yaml`, `.pi/pi-bash-in-docker/compose.yaml`, or `docker-compose.devcontainer.yml`.
   - `composeService`: the service name that owns the configured container, e.g. `pi-tools` or `app`.

   This removes ambiguity for non-standard Compose filenames and lets `docker_rebuild_restart` and `stopOnLastExit` use the right Compose file/service. Set `stopOnLastExit` to `true` only if the user wants the extension to stop the container/Compose service when the last Pi process using this config quits.

9. Create or update compose if the user wants lifecycle convenience.
   If Docker files are at the project root, a good default compose file is:
   ```yaml
   services:
     pi-tools:
       build:
         context: .
         dockerfile: Dockerfile
       container_name: pi-tools-my-project
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

   If Docker files are under `.pi/pi-bash-in-docker/`, put compose there and use repo-root-relative paths from that folder:
   ```yaml
   services:
     pi-tools:
       build:
         context: ../..
         dockerfile: .pi/pi-bash-in-docker/Dockerfile
       container_name: pi-tools-my-project
       init: true
       stdin_open: true
       tty: true
       working_dir: /workspace
       volumes:
         - ../..:/workspace
       ports:
         - "3000:3000"
       security_opt:
         - no-new-privileges:true
       command: sleep infinity
   ```

   Adjust ports for the project (`5173`, `3000`, `8000`, `8080`, etc.). If there may be multiple projects using this extension concurrently, use a project-specific `container_name`, e.g. `pi-tools-my-project`, and put that same name in `.pi/pi-bash-in-docker/config.json`. Also put the Compose file path and service name in that config (`"composeFile": "compose.yaml"` for root Compose, `"composeFile": ".pi/pi-bash-in-docker/compose.yaml"` for extension-local Compose, or the existing filename such as `"docker-compose.devcontainer.yml"`; `"composeService": "pi-tools"` or the actual service name).

10. If host Git/SSH identity sharing is enabled, add the optional compose settings below.

## Optional Host Git/SSH Identity Sharing

Enable this only after the user explicitly agrees.

Purpose:
- make `git config --get user.name` and `git config --get user.email` work inside the container;
- make `git push` over SSH work through the host `ssh-agent`;
- avoid copying private SSH keys into the image/container;
- optionally make GitHub CLI auth smoother when `gh` is installed and configured for SSH/git usage.

Security note to tell the user:

> This shares your host SSH agent with the container. It does not copy private keys, but processes in the container can use the agent socket to authenticate while the container is running. Only enable this for trusted project containers.

Compose additions for an image whose runtime user is `node` (keep the existing workspace bind mount; use `.:/workspace` for root compose or `../..:/workspace` for `.pi/pi-bash-in-docker/compose.yaml`):

```yaml
environment:
  SSH_AUTH_SOCK: /ssh-agent
volumes:
  - .:/workspace
  - /run/host-services/ssh-auth.sock:/ssh-agent
  - ~/.gitconfig:/home/node/.gitconfig:ro
  - ~/.config/git:/home/node/.config/git:ro
  - ~/.ssh/config:/home/node/.ssh/config:ro
  - ~/.ssh/known_hosts:/home/node/.ssh/known_hosts:ro
```

On macOS Docker Desktop, prefer `/run/host-services/ssh-auth.sock:/ssh-agent`; it is Docker Desktop's supported bridge to the host SSH agent. On Linux or other Docker setups, use the platform-appropriate agent socket mount, often `${SSH_AUTH_SOCK}:/ssh-agent` when that path is visible to Docker.

Also add matching exec settings to `.pi/pi-bash-in-docker/config.json`:

```json
{
  "container": "pi-tools-my-project",
  "containerCwd": "/workspace",
  "shell": "sh",
  "user": "node",
  "env": ["SSH_AUTH_SOCK=/ssh-agent"],
  "check": true,
  "autoStart": true
}
```

Adjust `/home/node` for the runtime user:
- `node` -> `/home/node`
- `sandboxuser` -> `/home/sandboxuser`
- `root` -> `/root`

Do **not** mount all of `~/.ssh` by default, even read-only, because it often contains private keys. If the user explicitly requests full SSH directory mounting, warn them first and prefer agent forwarding instead.

Host prerequisites:
- For the macOS Docker Desktop `/run/host-services/ssh-auth.sock` mount, Docker Desktop must have access to the host SSH agent.
- For `${SSH_AUTH_SOCK}:/ssh-agent` style mounts, `SSH_AUTH_SOCK` must be set in the environment used to run `docker compose up` and the path must be mountable by Docker.
- The host SSH agent should have the desired key loaded:
  ```bash
  ssh-add -l
  ```
- On macOS, avoid relying on the host `/private/tmp/.../Listeners` socket path when Docker Desktop's `/run/host-services/ssh-auth.sock` is available.

Verification commands inside the container:

```bash
git config --get user.name
git config --get user.email
ssh-add -l
ssh -T git@github.com
```

If `gh` is desired but missing, use the `docker-tool-install` skill to add GitHub CLI to the Dockerfile, then use `docker_rebuild_restart` to rebuild/recreate.

## Node Projects

Detect package manager by lockfile:

- `pnpm-lock.yaml` -> use corepack + pnpm
- `yarn.lock` -> use corepack + yarn
- `bun.lock` / `bun.lockb` -> consider `oven/bun` or install bun
- `package-lock.json` -> npm

Development Dockerfile template:

```dockerfile
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client sudo \
      procps psmisc less vim \
      ripgrep jq tree tmux fzf \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
    && chmod 0440 /etc/sudoers.d/node

WORKDIR /workspace
USER node

CMD ["sleep", "infinity"]
```

Do not copy the whole project into the image for this dev use case unless needed; the project is bind-mounted at runtime.

## Python Projects

Prefer a dev image that includes build tools only if needed. If the project uses `uv`, install/copy uv if appropriate.

Example:

```dockerfile
FROM python:3.12-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client sudo \
      procps psmisc less vim \
      ripgrep jq tree tmux fzf build-essential \
    && rm -rf /var/lib/apt/lists/*

ARG USERNAME=sandboxuser
ARG USER_UID=1000
ARG USER_GID=1000
RUN if ! getent group ${USER_GID} >/dev/null; then groupadd --gid ${USER_GID} ${USERNAME}; fi \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME}

WORKDIR /workspace
USER ${USERNAME}

CMD ["sleep", "infinity"]
```

## Dev Server Notes

For servers started by Pi bash commands:

```bash
mkdir -p /tmp/pi-bg
nohup npm run dev -- --host 0.0.0.0 > /tmp/pi-bg/dev.log 2>&1 < /dev/null &
echo $! > /tmp/pi-bg/dev.pid
```

Then inspect or stop later:

```bash
tail -n 100 /tmp/pi-bg/dev.log
kill "$(cat /tmp/pi-bg/dev.pid)"
```

Ensure ports are published when the container is created and the server binds to `0.0.0.0`.

## Final Response

After creating or modifying files, summarize:

- detected runtime/package manager;
- interview choices and defaults used;
- whether host Git/SSH identity sharing was enabled;
- files created/changed;
- image build command;
- container start command;
- Docker file location chosen (`.pi/pi-bash-in-docker/` or project root);
- `.pi/pi-bash-in-docker/config.json` contents if created;
- exact Pi command to use after installation. Prefer plain `pi` when project config was created; otherwise include necessary flags;
- verification commands for Docker routing and, if enabled, Git/SSH identity sharing.
