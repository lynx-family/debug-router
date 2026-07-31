import packageJson from "../../package.json";
import { Writable } from "stream";
import yargs from "yargs";
import { installSkill, SkillTarget } from "./installSkill";
import { CliLease } from "./CliLease";
import { ConnectorOwnershipGuard } from "./ConnectorOwnershipGuard";
import { DebugRouterSession } from "./DebugRouterSession";
import { CliError, CliPlatform } from "./types";

export type MainDependencies = {
  leaseFactory: () => CliLease;
  guardFactory: () => ConnectorOwnershipGuard;
  sessionFactory: () => DebugRouterSession;
  installSkill?: (options: {
    force?: boolean;
    target?: SkillTarget;
  }) => unknown;
};

export type MainStreams = {
  stdout: Writable;
  stderr: Writable;
  signal?: AbortSignal;
  signalExitCode?: number;
};

const defaults: MainDependencies = {
  leaseFactory: () => new CliLease(),
  guardFactory: () => new ConnectorOwnershipGuard(),
  sessionFactory: () => new DebugRouterSession(),
  installSkill,
};

export async function main(
  argv: string[],
  dependencies: MainDependencies = defaults,
  streams: MainStreams = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let parsed: any;
  if (argv.includes("--version") || argv.includes("-v")) {
    streams.stdout.write(`${packageJson.version}\n`);
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    streams.stdout.write(`${helpText()}\n`);
    return 0;
  }
  try {
    parsed = parse(argv);
  } catch (error: any) {
    writeError(streams.stderr, "USAGE_ERROR", error.message);
    return 2;
  }

  const command = parsed._[0];
  if (!command) {
    writeError(streams.stderr, "USAGE_ERROR", "A command is required");
    return 2;
  }
  if (command === "install-skill") {
    try {
      const result = (dependencies.installSkill ?? installSkill)({
        force: parsed.force,
        target: parsed.target,
      });
      streams.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    } catch (error: any) {
      const code =
        error.code ?? extractCode(error.message) ?? "SKILL_INSTALL_FAILED";
      writeError(streams.stderr, code, error.message, error.details);
      return 5;
    }
  }

  const lease = dependencies.leaseFactory();
  const session = dependencies.sessionFactory();
  let bufferedOutput: string | undefined;
  let exitStatus = 0;
  try {
    const startedAt = Date.now();
    await lease.acquire(parsed.waitTimeout, streams.signal);
    const remaining = Math.max(
      0,
      parsed.waitTimeout - (Date.now() - startedAt),
    );
    await dependencies
      .guardFactory()
      .wait(remaining, parsed.takeover, streams.signal);

    await session.open(parsed.platform as CliPlatform[], parsed.takeover);
    const snapshot = await raceAbort(
      session.discover(parsed.discoveryTimeout),
      streams.signal,
    );
    if (command === "list") {
      bufferedOutput = `${JSON.stringify(snapshot)}\n`;
    } else {
      const client = session.resolveTarget({
        deviceId: parsed.deviceId,
        clientId: parsed.clientId,
      });
      if (command === "send") {
        const type = parsed.type === "app" ? "App" : "CDP";
        const sessionId = type === "App" ? -1 : parsed.sessionId;
        const response = await raceAbort(
          session.send(
            client,
            parsed.method,
            parsed.params,
            sessionId,
            type,
            parsed.timeout,
          ),
          streams.signal,
        );
        bufferedOutput = `${JSON.stringify({
          deviceId: client.deviceId(),
          clientId: `${encodeURIComponent(client.deviceId())}:${
            client.info.port
          }`,
          type: parsed.type,
          method: parsed.method,
          sessionId,
          response,
        })}\n`;
      } else {
        await raceAbort(
          session.listen(
            client,
            (method, params, sessionId) => {
              streams.stdout.write(
                `${JSON.stringify({
                  deviceId: client.deviceId(),
                  clientId: `${encodeURIComponent(client.deviceId())}:${
                    client.info.port
                  }`,
                  method,
                  params,
                  sessionId,
                })}\n`,
              );
            },
            parsed.timeout,
          ),
          streams.signal,
        );
      }
    }
  } catch (error: any) {
    if (error?.name === "AbortError") {
      exitStatus = streams.signalExitCode ?? 130;
    } else {
      const code = error.code ?? extractCode(error.message) ?? "INTERNAL_ERROR";
      writeError(streams.stderr, code, error.message, error.details);
      exitStatus = exitCode(code);
    }
  } finally {
    let cleanupFailure: any;
    try {
      await session.close();
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      await lease.release();
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure) {
      writeError(
        streams.stderr,
        "CLEANUP_FAILED",
        cleanupFailure?.message ?? String(cleanupFailure),
      );
      exitStatus = 1;
    } else if (bufferedOutput) {
      streams.stdout.write(bufferedOutput);
    }
  }
  return exitStatus;
}

function parse(argv: string[]): any {
  const parser = yargs(argv)
    .exitProcess(false)
    .help(false)
    .version(false)
    .strict()
    .parserConfiguration({ "camel-case-expansion": true })
    .command("list", "List devices and clients")
    .command("send", "Send a protocol request", (command: any) =>
      command
        .option("method", { type: "string", demandOption: true })
        .option("params", { type: "string", default: "{}" })
        .option("type", { choices: ["cdp", "app"], default: "cdp" })
        .option("session-id", { type: "number", default: -1 })
        .option("timeout", { type: "number", default: 5000 }),
    )
    .command("listen", "Listen for all protocol events", (command: any) =>
      command.option("timeout", { type: "number" }),
    )
    .command(
      "install-skill",
      "Install the Debug Router agent Skill",
      (command: any) =>
        command
          .option("target", {
            choices: ["agents", "codex", "claude", "all"],
            default: "agents",
          })
          .option("force", { type: "boolean", default: false }),
    )
    .option("platform", {
      type: "array",
      choices: ["android", "ios", "harmony", "desktop"],
      default: [],
    })
    .option("discovery-timeout", { type: "number", default: 5000 })
    .option("wait-timeout", { type: "number", default: 60000 })
    .option("takeover", { type: "boolean", default: false })
    .option("device-id", { type: "string" })
    .option("client-id", { type: "string" })
    .fail((message: string, error: Error | undefined) => {
      throw error ?? new Error(message);
    });

  const parsed = parser.parse();
  if (parsed.discoveryTimeout <= 0 || parsed.waitTimeout < 0) {
    throw new Error("Timeout values are invalid");
  }
  if (parsed.timeout !== undefined && parsed.timeout <= 0) {
    throw new Error("--timeout must be positive");
  }
  if (parsed._[0] === "send") {
    if (!parsed.method.trim()) {
      throw new Error("--method must not be empty");
    }
    const params = JSON.parse(parsed.params);
    if (!params || Array.isArray(params) || typeof params !== "object") {
      throw new Error("--params must be a JSON object");
    }
    parsed.params = params;
    if (parsed.type === "app" && argv.includes("--session-id")) {
      throw new Error("--session-id is only valid for CDP");
    }
    if (!Number.isSafeInteger(parsed.sessionId)) {
      throw new Error("--session-id must be a safe integer");
    }
  }
  return parsed;
}

function helpText(): string {
  return [
    "debug-router <command>",
    "",
    "Commands:",
    "  list           List devices and clients",
    "  send           Send a CDP or App request",
    "  listen         Listen for all protocol events",
    "  install-skill  Install the Debug Router agent Skill",
  ].join("\n");
}

function raceAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return operation;
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function abortError(): Error {
  const error = new Error("Command aborted");
  error.name = "AbortError";
  return error;
}

function writeError(
  stream: Writable,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  stream.write(`${JSON.stringify({ error: { code, message, ...details } })}\n`);
}

function extractCode(message: string): string | undefined {
  return /^([A-Z_]+):/.exec(message)?.[1];
}

function exitCode(code: string): number {
  if (code === "USAGE_ERROR") return 2;
  if (code === "TARGET_NOT_FOUND" || code === "TARGET_AMBIGUOUS") return 3;
  if (code.startsWith("SKILL_")) return 5;
  if (
    code === "CONNECTOR_BUSY_TIMEOUT" ||
    code === "CONNECTOR_PREEMPTED" ||
    code.includes("TIMEOUT") ||
    code.includes("CONNECTION") ||
    code === "MALFORMED_PROTOCOL_RESPONSE"
  )
    return 4;
  return 1;
}
