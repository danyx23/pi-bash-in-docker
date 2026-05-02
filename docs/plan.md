# Pi Bash-in-Docker Extension Plan

## Goal

Create a Pi extension that lets Pi run on the macOS host while routing only `bash` execution into a running Docker container.

This preserves host-native integrations such as Glimpse, while allowing build/test/dev commands to execute in the same Linux/container environment as the application.

## Desired Architecture

```text
macOS host
├─ pi TUI / session / Glimpse companion
├─ read/edit/write tools operate directly on host filesystem
└─ bash tool and user `!` commands are delegated to Docker

Docker container
├─ project directory bind-mounted from host
├─ build/test/dev dependencies installed in container
└─ long-running dev servers can stay alive between bash invocations
```

## Why This Approach

Running Pi itself inside Docker makes native macOS integrations like Glimpse difficult because Glimpse needs to spawn/use native host UI APIs.

Running Pi on the host but delegating bash to Docker gives us:

- native Glimpse support on macOS;
- fast file read/edit/write on the host checkout;
- Linux/container execution for commands;
- no per-command container startup cost when using a long-running container;
- a simple mental model: files are shared through a bind mount, commands run inside the container.

## Relevant Pi Capabilities

Pi supports extension-based tool overrides and pluggable tool operations.

Relevant docs/examples in the installed Pi package:

- `docs/extensions.md`
  - section: `Remote Execution`
  - states that built-in tools support pluggable operations for SSH, containers, etc.
- `examples/extensions/ssh.ts`
  - delegates built-in tools to a remote machine via SSH;
  - useful reference for routing `bash` and `user_bash` through another execution backend.
- `examples/extensions/bash-spawn-hook.ts`
  - shows how to adjust bash command/cwd/env before execution.
- `examples/extensions/interactive-shell.ts`
  - intercepts user `!` commands for interactive terminal programs;
  - separate concern, but useful reference for `user_bash` handling.

Important exported APIs:

```ts
createBashTool
createLocalBashOperations
type BashOperations
type ExtensionAPI
```

For our first version, we only need to override:

- agent `bash` tool calls;
- user-entered `!` commands via the `user_bash` event.

We intentionally leave these on the host filesystem:

- `read`
- `edit`
- `write`
- possibly `ls`/`find`/`grep` unless added later

## Docker Execution Model

The extension should target an already-running container and execute commands using `docker exec`, not `docker run`.

Example container startup:

```bash
cd /path/to/project

docker run -d \
  --init \
  --name pi-tools \
  -v "$PWD":/workspace \
  -w /workspace \
  -p 3000:3000 \
  node:20-bookworm \
  sleep infinity
```

Example command execution:

```bash
docker exec -i -w /workspace pi-tools sh -lc '<command>'
```

This avoids container startup overhead for every Pi bash invocation.

## Configuration and CLI Flags

After the package is installed, Docker bash routing should work without extra flags when a project config exists. Without explicit Docker configuration, the extension should stay inert so other `bash`-overriding extensions can coexist.

Activation/config resolution order:

1. `--docker-container` CLI flag
2. project config: `.pi/bash-in-docker.json` or `.pi/docker-bash.json`
3. `PI_DOCKER_CONTAINER` environment variable

Other `PI_DOCKER_*` values tune an active configuration but do not activate Docker mode by themselves.

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

Supported flags:

```text
--docker-container <name-or-id>
  Container to use. If omitted, project/env/default configuration is used.

--docker-cwd <path>
  Container path corresponding to Pi's host cwd.
  Default: /workspace

--docker-shell <shell>
  Shell executable inside the container.
  Default: sh

--docker-local-cwd <path>
  Optional host path corresponding to docker-cwd.
  Default: process.cwd()

--docker-auto-start
  Start an existing stopped configured container before the session begins.

--docker-check
  Validate container exists, is running, and cwd is mounted.

--docker-user <user>
  Pass `-u <user>` to docker exec.

--docker-env KEY=VALUE
  Pass environment variables to docker exec.
```

Possible future flags:

```text
--docker-compose-service <service>
  Route through docker compose exec instead of docker exec.

--docker-user <user>
  Pass `-u <user>` to docker exec.

--docker-env KEY=VALUE
  Pass environment variables to docker exec.
```

## Path Mapping

The extension needs to map Pi's host cwd to the container cwd.

Example:

```text
host cwd:      /Users/daniel/code/cartogramm-editor
container cwd: /workspace
```

If a Pi bash call has cwd:

```text
/Users/daniel/code/cartogramm-editor/subdir
```

then the Docker workdir should become:

```text
/workspace/subdir
```

Initial mapping function:

```ts
function toContainerCwd(cwd: string): string {
  if (cwd === localCwd) return containerCwd;
  if (cwd.startsWith(localCwd + "/")) {
    return containerCwd + cwd.slice(localCwd.length);
  }
  return containerCwd;
}
```

## Background Processes / Web Servers

Pi does not need special background-process support for this basic workflow. A bash invocation can start a server in the background and return, while the server remains alive in the running container.

Recommended pattern inside the container:

```bash
mkdir -p /tmp/pi-bg
nohup npm run dev -- --host 0.0.0.0 > /tmp/pi-bg/dev.log 2>&1 < /dev/null &
echo $! > /tmp/pi-bg/dev.pid
```

Later commands can inspect or stop it:

```bash
tail -n 100 /tmp/pi-bg/dev.log
kill "$(cat /tmp/pi-bg/dev.pid)"
```

Important notes:

- Use `nohup` or `setsid`.
- Redirect stdin/stdout/stderr.
- Do not rely on plain `npm run dev &`; inherited stdio can cause `docker exec` to stay open.
- Start the container with `--init` so orphaned/zombie processes are handled better.
- Publish ports at container creation time, e.g. `-p 3000:3000`.
- Dev servers inside Docker should bind to `0.0.0.0`, not only `127.0.0.1`.

## Minimal Implementation Sketch

The extension should:

1. Register Docker-related flags.
2. On `session_start`, read flag values.
3. If `--docker-container` is absent, leave bash behavior unchanged.
4. If present:
   - create a `BashOperations` implementation that runs `docker exec`;
   - register/override the `bash` tool with `createBashTool(localCwd, { operations })`;
   - intercept `user_bash` and return `{ operations }`;
   - update the UI status bar;
   - append system prompt guidance explaining that bash runs in Docker while file tools operate on host files.

Pseudo-code shape:

```ts
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createLocalBashOperations,
  type BashOperations,
} from "@mariozechner/pi-coding-agent";

function createDockerBashOps(opts): BashOperations {
  return {
    exec(command, cwd, { onData, signal, timeout }) {
      // map cwd to container cwd
      // spawn docker exec -i -w <mapped-cwd> <container> <shell> -lc <command>
      // stream stdout/stderr to onData
      // support timeout and AbortSignal
      // resolve { exitCode }
    },
  };
}

export default function (pi: ExtensionAPI) {
  // register flags
  // create local fallback
  // create bash tool whose operations dispatch to docker if enabled
  // route user_bash similarly
  // append system prompt note
}
```

## Toolbox-Inspired Optional Extras

See also: [`toolbox-patterns.md`](./toolbox-patterns.md), based on investigation of `~/code/toolbox`.

Useful patterns to consider after the first minimal implementation:

- Deterministic project/container naming from project path slug + hash.
- Docker Compose service discovery via labels (`com.docker.compose.project` + `com.docker.compose.service`).
- `ensure_up` lifecycle support for compose-managed containers.
- Per-project config/state inspired by toolbox portable mode.
- `doctor`/validation checks for Docker availability, running container, cwd mount, and write visibility.
- Optional restricted Docker socket proxy for commands inside the target container that need Docker access.
- Optional `/docker-shell` or `/docker-tmux` command for interactive access to the same container.
- Recommended container hardening: `init: true`, non-root user, `no-new-privileges:true`, resource limits.

## Open Design Questions

1. Should the extension validate the container on startup?
   - `docker inspect -f '{{.State.Running}}' <container>`
   - `docker exec <container> test -d <docker-cwd>`

2. Should the extension auto-start a stopped container?
   - `docker start <container>`

3. Should `docker exec` run with `-t`?
   - For normal agent bash tool calls, probably **no**.
   - For interactive user commands, this is a separate feature and may need integration with `interactive-shell.ts`.

4. Should the extension support Docker Compose?
   - Useful command shape: `docker compose exec -T -w <cwd> <service> sh -lc <command>`.
   - Could be v2 after plain Docker works.

5. Should we add dedicated background-process tools?
   - Maybe later: `docker_bg_start`, `docker_bg_stop`, `docker_bg_logs`, `docker_bg_list`.
   - Not required for the first version because shell backgrounding works.

## First Milestone

Build a minimal working extension with:

- `--docker-container`
- `--docker-cwd`
- `--docker-shell`
- bash tool override
- `user_bash` routing
- cwd mapping
- streaming stdout/stderr
- timeout and abort handling
- UI status message
- system prompt appendix

Then test with:

```bash
pi \
  -e ~/pi-bash-in-docker/src/index.ts \
  --docker-container pi-tools \
  --docker-cwd /workspace
```

Test commands:

```bash
!pwd
!uname -a
!node --version
!echo hello > /workspace/.pi-docker-test
```

Then verify the file appears on the host:

```bash
ls -la .pi-docker-test
```

## Future Milestones

- Add Docker container validation and helpful diagnostics.
- Add auto-start support.
- Add Docker Compose support.
- Add background process helper tools.
- Add optional routing for `ls`/`find`/custom `grep` if needed.
- Package as a Pi package with `package.json` `pi.extensions` metadata.
