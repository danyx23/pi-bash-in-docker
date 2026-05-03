import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createBashTool, createLocalBashOperations, type BashOperations } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

type ConfigSource = "flag" | "project" | "legacy-project" | "env";

type DockerConfig = {
	container: string;
	localCwd: string;
	containerCwd: string;
	shell: string;
	user?: string;
	env: string[];
};

type RuntimeConfig = DockerConfig & {
	source: ConfigSource;
	autoStart: boolean;
	check: boolean;
	stopOnLastExit: boolean;
	lifecycleDir?: string;
};

type ProjectConfig = {
	container?: string;
	containerName?: string;
	localCwd?: string;
	hostCwd?: string;
	containerCwd?: string;
	cwd?: string;
	shell?: string;
	user?: string;
	env?: string[] | Record<string, string | number | boolean> | string;
	check?: boolean;
	autoStart?: boolean;
	stopOnLastExit?: boolean;
};

type ExecResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

type ContainerState = "running" | "stopped" | "missing" | "unknown";

const DEFAULT_CONTAINER = "pi-tools";
const DEFAULT_CONTAINER_CWD = "/workspace";
const DEFAULT_SHELL = "sh";
const PROJECT_CONFIG_PATH = ".pi/pi-bash-in-docker/config.json";
const LEGACY_CONFIG_PATHS = [".pi/bash-in-docker.json", ".pi/docker-bash.json"];
const CONFIG_PATHS = [PROJECT_CONFIG_PATH, ...LEGACY_CONFIG_PATHS];
const PROJECT_DOCKER_DIR = ".pi/pi-bash-in-docker";
const PROCESS_LIST_FILE = "processes.json";
const PROCESS_LOCK_DIR = ".processes.lock";
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

function flagString(pi: ExtensionAPI, name: string): string | undefined {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function flagBoolean(pi: ExtensionAPI, name: string): boolean {
	return pi.getFlag(name) === true;
}

function envString(name: string): string | undefined {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : undefined;
}

function envBoolean(name: string): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

function asBoolean(value: unknown): boolean {
	return value === true || value === "true" || value === "1" || value === "yes" || value === "on";
}

function envEntries(value: ProjectConfig["env"]): string[] {
	if (!value) return [];
	if (typeof value === "string") return parseEnvList(value);
	if (Array.isArray(value)) return value.filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry));
	return Object.entries(value)
		.map(([key, val]) => `${key}=${String(val)}`)
		.filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry));
}

function parseEnvList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry));
}

function loadProjectConfig(localCwd: string): { config: ProjectConfig; path: string; legacy: boolean } | undefined {
	for (const relPath of CONFIG_PATHS) {
		const path = join(localCwd, relPath);
		if (!existsSync(path)) continue;
		try {
			return {
				config: JSON.parse(readFileSync(path, "utf-8")) as ProjectConfig,
				path: relPath,
				legacy: LEGACY_CONFIG_PATHS.includes(relPath),
			};
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function pickString(...values: Array<string | undefined>): string | undefined {
	return values.find((value) => value !== undefined && value.trim() !== "");
}

function mapCwdToContainer(cwd: string, localCwd: string, containerCwd: string): string {
	if (cwd === localCwd) return containerCwd;
	const rel = relative(localCwd, cwd);
	if (!rel || rel === ".") return containerCwd;
	if (rel === ".." || rel.startsWith(`..${sep}`)) return containerCwd;
	return `${containerCwd.replace(/\/$/, "")}/${rel.split(sep).join("/")}`;
}

function spawnCollect(command: string, args: string[], options?: { signal?: AbortSignal; timeoutMs?: number; cwd?: string }): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd: options?.cwd });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;

		child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
		child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));

		const terminate = () => {
			if (!child.killed) child.kill("SIGTERM");
			killTimer = setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 2_000);
		};

		if (options?.timeoutMs && options.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				terminate();
			}, options.timeoutMs);
		}

		const onAbort = () => terminate();
		options?.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (error) => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			options?.signal?.removeEventListener("abort", onAbort);
			reject(error);
		});

		child.on("close", (exitCode) => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			options?.signal?.removeEventListener("abort", onAbort);
			if (timedOut) {
				reject(new Error(`timeout:${Math.round((options?.timeoutMs ?? 0) / 1000)}`));
				return;
			}
			if (options?.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			resolve({ exitCode, stdout, stderr });
		});
	});
}

async function docker(args: string[], options?: { signal?: AbortSignal; timeoutMs?: number; cwd?: string }): Promise<ExecResult> {
	return spawnCollect("docker", args, options);
}

function dockerExecArgs(config: DockerConfig, cwd: string, command: string): string[] {
	const args = ["exec", "-i", "-w", mapCwdToContainer(cwd, config.localCwd, config.containerCwd)];
	for (const env of config.env) args.push("-e", env);
	if (config.user) args.push("-u", config.user);
	args.push(config.container, config.shell, "-lc", command);
	return args;
}

function createDockerBashOps(getConfig: () => RuntimeConfig | undefined, localOps: BashOperations): BashOperations {
	return {
		exec(command, cwd, options) {
			const config = getConfig();
			if (!config) return localOps.exec(command, cwd, options);

			return new Promise((resolve, reject) => {
				const args = dockerExecArgs(config, cwd, command);
				const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				let timeoutTimer: NodeJS.Timeout | undefined;
				let killTimer: NodeJS.Timeout | undefined;

				child.stdout?.on("data", options.onData);
				child.stderr?.on("data", options.onData);

				const terminate = () => {
					if (!child.killed) child.kill("SIGTERM");
					killTimer = setTimeout(() => {
						if (!child.killed) child.kill("SIGKILL");
					}, 2_000);
				};

				if (options.timeout && options.timeout > 0) {
					timeoutTimer = setTimeout(() => {
						timedOut = true;
						terminate();
					}, options.timeout * 1000);
				}

				const onAbort = () => terminate();
				options.signal?.addEventListener("abort", onAbort, { once: true });

				child.on("error", (error) => {
					if (timeoutTimer) clearTimeout(timeoutTimer);
					if (killTimer) clearTimeout(killTimer);
					options.signal?.removeEventListener("abort", onAbort);
					reject(error);
				});

				child.on("close", (exitCode) => {
					if (timeoutTimer) clearTimeout(timeoutTimer);
					if (killTimer) clearTimeout(killTimer);
					options.signal?.removeEventListener("abort", onAbort);
					if (options.signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
					else resolve({ exitCode });
				});
			});
		},
	};
}

async function inspectContainerState(container: string): Promise<{ state: ContainerState; error?: string }> {
	try {
		const result = await docker(["inspect", "-f", "{{.State.Running}}", container], { timeoutMs: 5_000 });
		if (result.exitCode === 0) return { state: result.stdout.trim() === "true" ? "running" : "stopped" };
		const error = result.stderr.trim() || result.stdout.trim() || `Container not found: ${container}`;
		return { state: /no such object|not found/i.test(error) ? "missing" : "unknown", error };
	} catch (error) {
		return { state: "unknown", error: error instanceof Error ? error.message : String(error) };
	}
}

async function inspectRunning(container: string): Promise<boolean> {
	const result = await inspectContainerState(container);
	if (result.state === "running") return true;
	if (result.state === "stopped") return false;
	throw new Error(result.error || `Container not found: ${container}`);
}

async function assertContainerReady(config: DockerConfig): Promise<void> {
	const running = await inspectRunning(config.container);
	if (!running) throw new Error(`Container is not running: ${config.container}`);
	const result = await docker(["exec", config.container, "test", "-d", config.containerCwd], { timeoutMs: 5_000 });
	if (result.exitCode !== 0) {
		throw new Error(`Container cwd does not exist or is not a directory: ${config.containerCwd}`);
	}
}

function loadConfig(pi: ExtensionAPI, defaultLocalCwd: string): RuntimeConfig | undefined {
	const project = loadProjectConfig(defaultLocalCwd);
	const projectConfig = project?.config ?? {};
	const flaggedContainer = flagString(pi, "docker-container");
	const projectContainer = projectConfig.container ?? projectConfig.containerName;
	const envContainer = envString("PI_DOCKER_CONTAINER");

	// Stay inert unless Docker bash mode is explicitly requested. This lets other
	// extensions that override bash (for example pi-ssh) coexist when Docker mode
	// was not selected for the current Pi session/project.
	if (!flaggedContainer && !project && !envContainer) return undefined;

	const container = pickString(flaggedContainer, projectContainer, envContainer, DEFAULT_CONTAINER)!;
	const source: ConfigSource = flaggedContainer ? "flag" : project?.legacy ? "legacy-project" : project ? "project" : "env";

	return {
		container,
		localCwd: pickString(flagString(pi, "docker-local-cwd"), projectConfig.localCwd, projectConfig.hostCwd, envString("PI_DOCKER_LOCAL_CWD"), defaultLocalCwd)!,
		containerCwd: pickString(flagString(pi, "docker-cwd"), projectConfig.containerCwd, projectConfig.cwd, envString("PI_DOCKER_CWD"), DEFAULT_CONTAINER_CWD)!,
		shell: pickString(flagString(pi, "docker-shell"), projectConfig.shell, envString("PI_DOCKER_SHELL"), DEFAULT_SHELL)!,
		user: pickString(flagString(pi, "docker-user"), projectConfig.user, envString("PI_DOCKER_USER")),
		env: [...envEntries(projectConfig.env), ...parseEnvList(envString("PI_DOCKER_ENV")), ...parseEnvList(flagString(pi, "docker-env"))],
		source,
		autoStart: flagBoolean(pi, "docker-auto-start") || asBoolean(projectConfig.autoStart) || envBoolean("PI_DOCKER_AUTO_START"),
		check: flagBoolean(pi, "docker-check") || asBoolean(projectConfig.check) || envBoolean("PI_DOCKER_CHECK"),
		stopOnLastExit: flagBoolean(pi, "docker-stop-on-last-exit") || asBoolean(projectConfig.stopOnLastExit) || envBoolean("PI_DOCKER_STOP_ON_LAST_EXIT"),
		lifecycleDir: project ? join(defaultLocalCwd, dirname(project.path)) : undefined,
	};
}

function configSummary(config: DockerConfig): string {
	return `${config.container}:${config.containerCwd}`;
}

function sourceLabel(config: RuntimeConfig): string {
	return `${config.source} config`;
}

function findComposeDir(localCwd: string): string | undefined {
	if (COMPOSE_FILES.some((file) => existsSync(join(localCwd, file)))) return localCwd;
	const projectDockerDir = join(localCwd, PROJECT_DOCKER_DIR);
	if (COMPOSE_FILES.some((file) => existsSync(join(projectDockerDir, file)))) return projectDockerDir;
	return undefined;
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function formatDockerCommand(args: string[]): string {
	return `docker ${args.map(shellQuote).join(" ")}`;
}

type ProcessList = {
	pids?: number[];
};

function pidExists(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function withProcessListLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
	const lockDir = join(dir, PROCESS_LOCK_DIR);
	mkdirSync(dir, { recursive: true });
	const deadline = Date.now() + 5_000;
	while (true) {
		try {
			mkdirSync(lockDir);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() > deadline) {
				rmSync(lockDir, { recursive: true, force: true });
				continue;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	try {
		return await fn();
	} finally {
		rmSync(lockDir, { recursive: true, force: true });
	}
}

function readProcessList(dir: string): number[] {
	const path = join(dir, PROCESS_LIST_FILE);
	if (!existsSync(path)) return [];
	try {
		const data = JSON.parse(readFileSync(path, "utf-8")) as ProcessList;
		return Array.isArray(data.pids) ? data.pids.filter((pid) => Number.isInteger(pid) && pid > 0) : [];
	} catch {
		return [];
	}
}

function writeProcessList(dir: string, pids: number[]): void {
	const path = join(dir, PROCESS_LIST_FILE);
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify({ pids }, null, 2)}\n`);
	renameSync(tmpPath, path);
}

async function addCurrentProcess(dir: string): Promise<void> {
	await withProcessListLock(dir, () => {
		const pids = Array.from(new Set([...readProcessList(dir), process.pid])).filter(pidExists);
		writeProcessList(dir, pids);
	});
}

async function removeCurrentProcess(dir: string): Promise<number[]> {
	return withProcessListLock(dir, () => {
		const pids = readProcessList(dir).filter((pid) => pid !== process.pid && pidExists(pid));
		writeProcessList(dir, pids);
		return pids;
	});
}

function summarizeStep(label: string, args: string[], result: ExecResult): string {
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	const tail = output.length > 6000 ? `...\n${output.slice(-6000)}` : output;
	return [`$ ${formatDockerCommand(args)}`, `${label}: exit ${result.exitCode}`, tail].filter(Boolean).join("\n");
}

function setBashStatus(ctx: ExtensionContext, candidate: RuntimeConfig | undefined, state: ContainerState | undefined, routedToDocker: boolean): void {
	if (!ctx.hasUI) return;
	const theme = ctx.ui.theme;
	if (routedToDocker && candidate) {
		ctx.ui.setStatus("docker", `${theme.fg("success", "Bash: docker")} ${theme.fg("accent", configSummary(candidate))} ${theme.fg("dim", "● running")}`);
		return;
	}
	const host = theme.fg("dim", "Bash: host");
	if (!candidate || !state) {
		ctx.ui.setStatus("docker", host);
		return;
	}
	const dockerState = state === "missing" ? `${candidate.container} missing` : `${configSummary(candidate)} ${state}`;
	const color = state === "missing" ? "error" : state === "stopped" ? "warning" : "dim";
	ctx.ui.setStatus("docker", `${host} ${theme.fg(color, `(docker ${dockerState})`)}`);
}

async function inferComposeService(localCwd: string, requestedService?: string): Promise<string> {
	if (requestedService?.trim()) return requestedService.trim();

	const servicesResult = await docker(["compose", "config", "--services"], { cwd: localCwd, timeoutMs: 30_000 });
	if (servicesResult.exitCode !== 0) throw new Error(servicesResult.stderr.trim() || "Failed to list docker compose services");

	const services = servicesResult.stdout
		.split(/\r?\n/)
		.map((service) => service.trim())
		.filter(Boolean);

	if (services.includes("pi-tools")) return "pi-tools";
	if (services.length === 1) return services[0];
	if (services.length === 0) throw new Error("No services found in docker compose config");
	throw new Error(`Multiple compose services found (${services.join(", ")}); pass the service parameter`);
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("docker-container", {
		description: "Activate Docker bash routing for this container",
		type: "string",
	});
	pi.registerFlag("docker-cwd", {
		description: "Container path corresponding to the host cwd (default: /workspace)",
		type: "string",
	});
	pi.registerFlag("docker-local-cwd", {
		description: "Host path corresponding to --docker-cwd (defaults to process.cwd())",
		type: "string",
	});
	pi.registerFlag("docker-shell", {
		description: "Shell executable inside the container (default: sh)",
		type: "string",
	});
	pi.registerFlag("docker-user", {
		description: "User/UID passed to docker exec -u",
		type: "string",
	});
	pi.registerFlag("docker-env", {
		description: "Comma-separated KEY=VALUE entries passed to docker exec -e",
		type: "string",
	});
	pi.registerFlag("docker-check", {
		description: "Validate Docker container and container cwd on session start",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("docker-auto-start", {
		description: "Run docker start for the configured container if it is stopped",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("docker-stop-on-last-exit", {
		description: "Stop the configured Docker container when the last Pi process using this project config exits",
		type: "boolean",
		default: false,
	});

	const initialCwd = process.cwd();
	const localOps = createLocalBashOperations();
	let config: RuntimeConfig | undefined;
	let statusTimer: NodeJS.Timeout | undefined;
	let activeLifecycleDir: string | undefined;
	let activeLifecycleConfig: RuntimeConfig | undefined;

	async function refreshDockerMode(ctx: ExtensionContext, options?: { notify?: boolean; allowAutoStart?: boolean }): Promise<void> {
		const candidate = loadConfig(pi, ctx.cwd);
		if (!candidate) {
			config = undefined;
			setBashStatus(ctx, undefined, undefined, false);
			return;
		}
		ensureBashOverrideRegistered();
		let state = await inspectContainerState(candidate.container);

		try {
			if (state.state === "stopped" && candidate.autoStart && options?.allowAutoStart) {
				const started = await docker(["start", candidate.container], { timeoutMs: 30_000 });
				if (started.exitCode !== 0) throw new Error(started.stderr.trim() || `docker start failed: ${candidate.container}`);
				state = await inspectContainerState(candidate.container);
			}

			if (state.state === "running") {
				if (candidate.check) await assertContainerReady(candidate);
				config = candidate;
				setBashStatus(ctx, candidate, state.state, true);
				if (options?.notify && ctx.hasUI) ctx.ui.notify(`Docker bash enabled from ${sourceLabel(candidate)}: ${configSummary(candidate)}`, "info");
				return;
			}

			config = undefined;
			setBashStatus(ctx, candidate, state.state, false);
			if (options?.notify && ctx.hasUI) {
				const reason = state.error || `Container is ${state.state}: ${candidate.container}`;
				ctx.ui.notify(`Docker bash disabled; bash commands run on host: ${reason}`, state.state === "stopped" ? "warning" : "error");
			}
		} catch (error) {
			config = undefined;
			setBashStatus(ctx, candidate, "unknown", false);
			if (options?.notify && ctx.hasUI) {
				ctx.ui.notify(`Docker bash disabled; bash commands run on host: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
	}

	async function stopContainerAfterLastExit(lifecycleConfig: RuntimeConfig): Promise<void> {
		const composeDir = findComposeDir(lifecycleConfig.localCwd);
		if (composeDir) {
			try {
				const service = await inferComposeService(composeDir);
				const result = await docker(["compose", "stop", service], { cwd: composeDir, timeoutMs: 30_000 });
				if (result.exitCode === 0) return;
			} catch {
				// Fall back to stopping the configured container by name below.
			}
		}
		await docker(["stop", lifecycleConfig.container], { timeoutMs: 30_000 });
	}

	async function updateLifecycleRegistration(): Promise<void> {
		const nextDir = config?.stopOnLastExit ? config.lifecycleDir : undefined;
		if (activeLifecycleDir && activeLifecycleDir !== nextDir) {
			await removeCurrentProcess(activeLifecycleDir);
			activeLifecycleDir = undefined;
			activeLifecycleConfig = undefined;
		}
		if (!nextDir || !config) return;
		await addCurrentProcess(nextDir);
		activeLifecycleDir = nextDir;
		activeLifecycleConfig = config;
	}

	const dockerOps = createDockerBashOps(() => config, localOps);
	let bashOverrideRegistered = false;

	function ensureBashOverrideRegistered(): void {
		if (bashOverrideRegistered) return;
		bashOverrideRegistered = true;
		const bashTool = createBashTool(initialCwd, { operations: dockerOps });
		pi.registerTool({
			...bashTool,
			label: "bash (docker)",
			execute: async (id, params, signal, onUpdate, ctx) => createBashTool(ctx.cwd, { operations: dockerOps }).execute(id, params, signal, onUpdate),
		});
	}

	pi.registerTool({
		name: "docker_rebuild_restart",
		label: "Docker Rebuild",
		description:
			"Rebuild and recreate the pi-bash-in-docker development container from the host Pi process, outside the Docker-routed bash tool. Requires a Docker Compose file in the project.",
		promptSnippet: "Rebuild/recreate the Docker bash container from the host when Dockerfile changes need to take effect.",
		promptGuidelines: [
			"Use docker_rebuild_restart after modifying a Dockerfile or compose setup for pi-bash-in-docker, because ordinary bash commands may run inside the container and may not have access to the host Docker daemon.",
			"Ask the user before using docker_rebuild_restart unless they explicitly requested a rebuild/restart of the Docker container.",
		],
		parameters: Type.Object({
			service: Type.Optional(Type.String({ description: "Docker Compose service to rebuild/recreate. Defaults to pi-tools when present, or the only compose service." })),
			noCache: Type.Optional(Type.Boolean({ description: "Run docker compose build with --no-cache before recreating the service." })),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Timeout for each docker compose step in seconds. Defaults to 600." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!ctx.hasUI) {
				throw new Error("docker_rebuild_restart requires an interactive/RPC UI confirmation.");
			}

			const localCwd = ctx.cwd;
			const composeDir = findComposeDir(localCwd);
			if (!composeDir) {
				throw new Error(`No compose.yaml/compose.yml/docker-compose.yaml/docker-compose.yml found in the Pi project cwd or ${PROJECT_DOCKER_DIR}; cannot safely recreate the container from image metadata alone.`);
			}

			const service = await inferComposeService(composeDir, params.service);
			const timeoutMs = Math.max(1, params.timeoutSeconds ?? 600) * 1000;
			const current = loadConfig(pi, localCwd);
			if (!current) {
				throw new Error(`Docker bash mode is not configured. Start Pi with --docker-container <name>, set PI_DOCKER_CONTAINER, or add ${PROJECT_CONFIG_PATH}.`);
			}
			ensureBashOverrideRegistered();
			const steps: string[] = [];
			const append = (text: string) => {
				steps.push(text);
				onUpdate?.({ content: [{ type: "text", text: steps.join("\n\n") }], details: { steps: [...steps], service, container: current.container } });
			};

			const ok = await ctx.ui.confirm(
				"Rebuild Docker container?",
				`Run host Docker Compose commands to rebuild and force-recreate service '${service}' for container '${current.container}'? This may stop running processes in that container.`,
			);
			if (!ok) {
				return { content: [{ type: "text", text: "Cancelled Docker rebuild/recreate." }], details: { cancelled: true, service, container: current.container } };
			}

			const buildArgs = ["compose", "build", ...(params.noCache ? ["--no-cache"] : []), service];
			append(`Starting ${formatDockerCommand(buildArgs)} in ${composeDir}`);
			const build = await docker(buildArgs, { cwd: composeDir, timeoutMs, signal });
			append(summarizeStep("build", buildArgs, build));
			if (build.exitCode !== 0) throw new Error(`Docker compose build failed for service '${service}'`);

			const upArgs = ["compose", "up", "-d", "--force-recreate", service];
			append(`Starting ${formatDockerCommand(upArgs)} in ${composeDir}`);
			const up = await docker(upArgs, { cwd: composeDir, timeoutMs, signal });
			append(summarizeStep("up", upArgs, up));
			if (up.exitCode !== 0) throw new Error(`Docker compose up failed for service '${service}'`);

			let verification = "";
			try {
				await assertContainerReady(current);
				config = current;
				setBashStatus(ctx, current, "running", true);
				const check = await docker(["exec", "-w", current.containerCwd, current.container, current.shell, "-lc", "pwd && id && uname -s"], { timeoutMs: 10_000 });
				verification = check.stdout.trim();
				append(`Verification for ${configSummary(current)}:\n${verification}`);
			} catch (error) {
				verification = `Container was recreated, but verification failed: ${error instanceof Error ? error.message : String(error)}`;
				append(verification);
			}

			return {
				content: [
					{
						type: "text",
						text: `Rebuilt and recreated Docker Compose service '${service}' from host Pi process.\n\n${steps.join("\n\n")}`,
					},
				],
				details: { service, container: current.container, steps, verification },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshDockerMode(ctx, { notify: true, allowAutoStart: true });
		await updateLifecycleRegistration();
		if (statusTimer) clearInterval(statusTimer);
		if (ctx.hasUI) {
			statusTimer = setInterval(() => {
				void refreshDockerMode(ctx);
			}, 10_000);
			statusTimer.unref?.();
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
		if (event.reason !== "quit" || !activeLifecycleDir || !activeLifecycleConfig) return;
		const dir = activeLifecycleDir;
		const lifecycleConfig = activeLifecycleConfig;
		activeLifecycleDir = undefined;
		activeLifecycleConfig = undefined;
		const remainingPids = await removeCurrentProcess(dir);
		if (remainingPids.length === 0) await stopContainerAfterLastExit(lifecycleConfig);
	});

	pi.on("user_bash", () => {
		if (!config) return;
		ensureBashOverrideRegistered();
		return { operations: dockerOps };
	});

	pi.on("before_agent_start", (event) => {
		if (!config) return;
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\nDocker bash mode is enabled. The bash tool and user ! commands run inside Docker container ${JSON.stringify(config.container)} with container cwd ${JSON.stringify(config.containerCwd)}. File tools such as read, edit, and write operate on the host filesystem rooted at ${JSON.stringify(config.localCwd)}, which should be bind-mounted into the container at ${JSON.stringify(config.containerCwd)}. Prefer commands that work inside the container. For long-running servers, start them in the background with nohup/setsid and redirect stdin/stdout/stderr, then inspect logs in later bash calls.`,
		};
	});

	pi.registerCommand("docker-status", {
		description: "Show configured Docker bash container status",
		handler: async (_args, ctx) => {
			await refreshDockerMode(ctx);
			const current = config ?? loadConfig(pi, ctx.cwd);
			if (!current) {
				if (ctx.hasUI) ctx.ui.notify(`Docker bash mode is inactive. Start Pi with --docker-container <name>, set PI_DOCKER_CONTAINER, or add ${PROJECT_CONFIG_PATH}.`, "info");
				return;
			}
			const result = await docker(["inspect", "-f", "name={{.Name}} running={{.State.Running}} image={{.Config.Image}}", current.container], { timeoutMs: 5_000 });
			if (!ctx.hasUI) return;
			const route = config ? "bash=docker" : "bash=host";
			if (result.exitCode === 0) ctx.ui.notify(`${result.stdout.trim().replace(/^name=\//, "name=")} ${route} source=${sourceLabel(current)}`, "info");
			else ctx.ui.notify(`${result.stderr.trim() || `Container not found: ${current.container}`} ${route}`, "error");
		},
	});

	pi.registerCommand("docker-start", {
		description: "Start the configured Docker bash container (or /docker-start <container>)",
		handler: async (args, ctx) => {
			const requested = args.trim();
			const current = loadConfig(pi, ctx.cwd);
			if (!current && !requested) {
				if (ctx.hasUI) ctx.ui.notify("Docker bash mode is inactive. Pass a container name: /docker-start <container>", "warning");
				return;
			}
			const container = requested || config?.container || current!.container;
			const nextConfig: RuntimeConfig = current ?? {
				container,
				localCwd: ctx.cwd,
				containerCwd: DEFAULT_CONTAINER_CWD,
				shell: DEFAULT_SHELL,
				env: [],
				source: "flag",
				autoStart: false,
				check: false,
				stopOnLastExit: false,
			};
			const result = await docker(["start", container], { timeoutMs: 30_000 });
			if (result.exitCode === 0) {
				ensureBashOverrideRegistered();
				config = { ...nextConfig, container };
				await updateLifecycleRegistration();
				if (ctx.hasUI) {
					setBashStatus(ctx, config, "running", true);
					ctx.ui.notify(`Started Docker container: ${container}`, "info");
				}
			} else if (ctx.hasUI) {
				ctx.ui.notify(result.stderr.trim() || `Failed to start container: ${container}`, "error");
			}
		},
	});

	pi.registerCommand("docker-stop", {
		description: "Stop the configured Docker bash container (or /docker-stop <container>)",
		handler: async (args, ctx) => {
			const requested = args.trim();
			const current = loadConfig(pi, ctx.cwd);
			if (!current && !config && !requested) {
				if (ctx.hasUI) ctx.ui.notify("Docker bash mode is inactive. Pass a container name: /docker-stop <container>", "warning");
				return;
			}
			const container = requested || config?.container || current!.container;
			const statusConfig = current ?? config ?? {
				container,
				localCwd: ctx.cwd,
				containerCwd: DEFAULT_CONTAINER_CWD,
				shell: DEFAULT_SHELL,
				env: [],
				source: "flag" as const,
				autoStart: false,
				check: false,
				stopOnLastExit: false,
			};
			const result = await docker(["stop", container], { timeoutMs: 30_000 });
			if (result.exitCode === 0) {
				if (config?.container === container) {
					config = undefined;
					await updateLifecycleRegistration();
				}
				if (ctx.hasUI) {
					setBashStatus(ctx, { ...statusConfig, container }, "stopped", false);
					ctx.ui.notify(`Stopped Docker container: ${container}; bash commands run on host`, "info");
				}
			} else if (ctx.hasUI) {
				ctx.ui.notify(result.stderr.trim() || `Failed to stop container: ${container}`, "error");
			}
		},
	});

	pi.registerCommand("docker-doctor", {
		description: "Validate Docker bash container configuration",
		handler: async (_args, ctx) => {
			const current = config ?? loadConfig(pi, ctx.cwd);
			if (!current) {
				if (ctx.hasUI) ctx.ui.notify(`Docker bash mode is inactive. Start Pi with --docker-container <name>, set PI_DOCKER_CONTAINER, or add ${PROJECT_CONFIG_PATH}.`, "warning");
				return;
			}
			try {
				await assertContainerReady(current);
				const pwd = await docker(["exec", "-w", current.containerCwd, current.container, current.shell, "-lc", "pwd && id && uname -a"], { timeoutMs: 10_000 });
				if (pwd.exitCode !== 0) throw new Error(pwd.stderr.trim() || "docker exec check failed");
				if (ctx.hasUI) ctx.ui.notify(`Docker bash OK: ${configSummary(current)} (${sourceLabel(current)})\n${pwd.stdout.trim()}`, "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Docker doctor failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
