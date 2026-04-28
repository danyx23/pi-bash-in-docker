---
name: docker-tool-install
description: Add missing command-line tools or software to the Docker development container used by pi-bash-in-docker. Use when a binary is not found, a command fails with "command not found", or the user asks to install packages/tools/software in the Docker container.
---

# Docker Tool Install for Pi Bash-in-Docker

Use this skill when commands fail because a binary is missing, or when the user asks to install software for the Docker container used by `pi-bash-in-docker`.

The goal is to make tools persistently available by updating the project's container definition, not by only installing packages into the currently running container.

## Core Rule

When a missing tool is detected, ask the user before changing the Dockerfile:

> The tool `<tool>` is not available in the Docker container. Should I add it to the Dockerfile and rebuild the Pi Docker container so it is available in future sessions?

Only edit the Dockerfile after the user agrees. If the user asks directly to install/add the tool, treat that as consent.

## Workflow

1. Confirm the missing tool and current context.
   - Run checks such as:
     ```bash
     command -v <tool> || true
     <tool> --version || true
     uname -s
     pwd
     ```
   - If bash is routed through Docker, `uname -s` should report `Linux` and `pwd` should be under `/workspace`.

2. Inspect project container files before editing.
   - Read `Dockerfile`.
   - Check for `compose.yaml`, `docker-compose.yml`, or `compose.*.yaml`.
   - Read `.pi/bash-in-docker.json` to identify the configured container name when present.

3. Determine how to install the tool.
   - Debian/Ubuntu images: prefer `apt-get install -y --no-install-recommends <package>`.
   - Node tools: prefer project/package-manager appropriate installs when the tool is a project dependency; otherwise consider `npm install -g <package>` only for CLI tooling that is intentionally global.
   - Python tools: prefer project dependency files or `pipx`; use `pip install` only when appropriate for the image/project.
   - Language toolchains may need official install scripts, but prefer distro packages when reliable.
   - Avoid installing secrets or user-specific credentials into the image.

4. Ask for confirmation unless the user already directly requested the installation.
   - Be explicit about the Dockerfile change and package name(s).
   - Mention that a rebuild/recreate is required for the running container to pick up image changes.

5. Modify the Dockerfile.
   - Keep edits minimal.
   - Add packages to an existing install block when one exists.
   - Preserve lockfiles and project files.
   - If no Dockerfile exists, use the `docker-init` skill first.

6. Rebuild the image and recreate the container.
   - If the project has a Compose file and the `docker_rebuild_restart` tool is available, prefer that tool. It runs from the host Pi process rather than from the Docker-routed bash tool, so it can access the host Docker daemon even when normal bash commands run inside the container.
   - `docker_rebuild_restart` asks for confirmation and then runs the host equivalent of:
     ```bash
     docker compose build <service>
     docker compose up -d --force-recreate <service>
     ```
   - If the tool is not available but Docker CLI is available from the current shell, use:
     ```bash
     docker compose build
     docker compose up -d --force-recreate <service>
     ```
   - Otherwise tell the user to run the host commands in a normal host terminal.
   - For non-Compose setups, use an image/container command appropriate for the project, e.g.:
     ```bash
     docker build -t pi-tools-image .
     docker rm -f pi-tools
     docker run -d --init --name pi-tools -v "$PWD":/workspace -w /workspace pi-tools-image sleep infinity
     ```

7. Be aware of routed bash limitations.

   If Pi bash commands are currently routed inside the Docker container, plain `docker ...` commands may not be available because they run inside that container. Check with:

   ```bash
   command -v docker || true
   ```

   Use `docker_rebuild_restart` when possible for Compose projects. The extension slash commands run in the Pi host process, but they only start/stop existing containers; they do not rebuild images.

   If a container is configured in `.pi/bash-in-docker.json`, restarting/recreating it may interrupt running processes in that container. The extension should reconnect to the recreated container by name; if it does not, restart Pi or run `/docker-start`.

8. Verify the tool after rebuild/recreate.
   - In the new container, run:
     ```bash
     command -v <tool>
     <tool> --version || true
     ```
   - Also verify Docker routing if relevant:
     ```bash
     uname -s
     pwd
     ```

## Host vs Container Rebuild Notes

Because `pi-bash-in-docker` routes Pi `bash` calls into the container, rebuilding Docker from inside Pi may be impossible unless the container has access to the host Docker daemon. This is expected.

If Docker is unavailable inside the routed bash environment, provide exact host commands for the user, for example:

```bash
docker compose build
docker compose up -d --force-recreate pi-tools
```

or:

```bash
docker build -t pi-tools-image .
docker rm -f pi-tools
docker run -d --init --name pi-tools -v "$PWD":/workspace -w /workspace pi-tools-image sleep infinity
```

Then instruct the user to restart Pi so the extension reconnects to the recreated container:

```bash
pi
```

## Final Response

After installing or preparing tool installation, summarize:

- missing/requested tool and package name;
- Dockerfile changes made;
- rebuild command run or host command the user must run;
- restart/recreate command run or host command the user must run;
- verification command and result, if available;
- whether Pi should be restarted afterward.
