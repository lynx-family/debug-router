#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const TARGETS = new Set(["agents", "codex", "claude", "all"]);

function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArgs(argv);
  const packageRoot = path.resolve(__dirname, "..");
  const packageJson = require(path.join(packageRoot, "package.json"));
  const npm = npmCommand(environment);

  run(npm.command, [...npm.args, "ci"], {
    cwd: packageRoot,
    stdio: "inherit",
    environment,
    description: "npm ci",
  });
  run(npm.command, [...npm.args, "run", "build"], {
    cwd: packageRoot,
    stdio: "inherit",
    environment,
    description: "npm run build",
  });
  run(
    npm.command,
    [...npm.args, "install", "--global", ".", "--ignore-scripts"],
    {
      cwd: packageRoot,
      stdio: "inherit",
      environment,
      description: "npm install --global .",
    },
  );

  const prefixResult = run(npm.command, [...npm.args, "prefix", "--global"], {
    cwd: packageRoot,
    encoding: "utf8",
    environment,
    description: "npm prefix --global",
  });
  const prefix = prefixResult.stdout.trim();
  if (!prefix) {
    throw new Error("npm prefix --global returned an empty path");
  }
  const binDirectory =
    process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const binPath = path.join(
    binDirectory,
    process.platform === "win32" ? "debug-router.cmd" : "debug-router",
  );
  if (!fs.existsSync(binPath)) {
    throw new Error(
      `Global debug-router executable was not created: ${binPath}`,
    );
  }

  const versionResult = run(binPath, ["--version"], {
    cwd: packageRoot,
    encoding: "utf8",
    environment,
    description: "debug-router --version",
  });
  const actualVersion = versionResult.stdout.trim();
  if (actualVersion !== packageJson.version) {
    throw new Error(
      `Installed debug-router version ${
        actualVersion || "<empty>"
      } does not match ${packageJson.version}`,
    );
  }

  const installArgs = ["install-skill", "--target", options.target];
  if (options.force) {
    installArgs.push("--force");
  }
  const skillResult = run(binPath, installArgs, {
    cwd: packageRoot,
    encoding: "utf8",
    environment,
    description: "debug-router install-skill",
  });
  let skill;
  try {
    skill = JSON.parse(skillResult.stdout);
  } catch {
    throw new Error("debug-router install-skill returned invalid JSON");
  }
  if (skill.installed !== true) {
    throw new Error("debug-router install-skill did not report success");
  }

  const pathExecutable = resolveOnPath("debug-router", environment);
  const pathResult = pathExecutable
    ? spawnSync(pathExecutable, ["--version"], {
        cwd: packageRoot,
        encoding: "utf8",
        env: environment,
        shell: false,
      })
    : undefined;
  const pathAvailable =
    pathExecutable !== undefined &&
    fs.realpathSync(pathExecutable) === fs.realpathSync(binPath) &&
    pathResult !== undefined &&
    !pathResult.error &&
    pathResult.status === 0 &&
    pathResult.stdout.trim() === packageJson.version;

  process.stdout.write(
    `${JSON.stringify({
      installed: true,
      cli: {
        path: binPath,
        version: actualVersion,
        pathAvailable,
      },
      skill,
    })}\n`,
  );

  if (!pathAvailable) {
    process.stderr.write(
      `debug-router was installed at ${binPath}, but ${binDirectory} is not available on PATH. Add that directory to PATH and restart the shell.\n`,
    );
    return 1;
  }
  return 0;
}

function parseArgs(argv) {
  let target = "agents";
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--target") {
      index += 1;
      if (index >= argv.length) {
        throw new Error("--target requires a value");
      }
      target = argv[index];
      continue;
    }
    if (argument.startsWith("--target=")) {
      target = argument.slice("--target=".length);
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (!TARGETS.has(target)) {
    throw new Error(`Invalid --target: ${target}`);
  }
  return { target, force };
}

function npmCommand(environment) {
  if (environment.npm_execpath) {
    return {
      command: process.execPath,
      args: [environment.npm_execpath],
    };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: [],
  };
}

function resolveOnPath(command, environment) {
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const extensions =
    process.platform === "win32"
      ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: options.encoding,
    env: options.environment,
    shell: false,
    stdio: options.stdio,
  });
  if (result.error) {
    throw new Error(`${options.description} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (options.encoding && result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error(
      `${options.description} failed with exit code ${
        result.status ?? "unknown"
      }`,
    );
  }
  return result;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };
