import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { CliError } from "./types";

const MANIFEST = ".debug-router-connector.json";
const MANIFEST_VERSION = 2;

export type SkillTarget = "agents" | "codex" | "claude" | "all";
type ConcreteSkillTarget = Exclude<SkillTarget, "all">;

export type InstallSkillOptions = {
  home?: string;
  codexHome?: string;
  packageRoot?: string;
  force?: boolean;
  target?: SkillTarget;
};

export type InstalledSkillTarget = {
  target: ConcreteSkillTarget;
  path: string;
};

export type InstallSkillResult = {
  installed: true;
  path: string;
  target: SkillTarget;
  targets: InstalledSkillTarget[];
  legacyCopies: string[];
  version: string;
};

type ManagedFiles = Record<string, string>;

type SkillManifest = {
  schemaVersion: 2;
  package: string;
  version: string;
  files: ManagedFiles;
};

type SourceFile = {
  relativePath: string;
  content: Buffer;
  hash: string;
};

export function installSkill(
  options: InstallSkillOptions = {},
): InstallSkillResult {
  const home = options.home ?? os.homedir();
  const packageRoot = options.packageRoot ?? findPackageRoot(__dirname);
  const target = options.target ?? "agents";
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  const sourceRoot = path.join(packageRoot, "skills", "debug-router");
  const sourceFiles = readSourceFiles(sourceRoot);
  const destinations = resolveDestinations(target, home, options);

  for (const destination of destinations) {
    installDestination(
      sourceFiles,
      destination.path,
      packageJson.name,
      packageJson.version,
      options.force ?? false,
    );
  }

  const legacyClaudePath = destinationFor("claude", home, options);
  const legacyCopies =
    destinations.some(({ path: value }) => value === legacyClaudePath) ||
    !fs.existsSync(path.join(legacyClaudePath, "SKILL.md"))
      ? []
      : [legacyClaudePath];

  return {
    installed: true,
    path: destinations[0].path,
    target,
    targets: destinations,
    legacyCopies,
    version: packageJson.version,
  };
}

function installDestination(
  sourceFiles: SourceFile[],
  destination: string,
  packageName: string,
  packageVersion: string,
  force: boolean,
): void {
  assertNoSymlinkComponents(destination);
  if (fs.existsSync(destination) && !fs.lstatSync(destination).isDirectory()) {
    throw conflict(`Skill destination is not a directory: ${destination}`);
  }

  const manifestPath = path.join(destination, MANIFEST);
  assertNoSymlinkComponents(manifestPath);
  const previous = fs.existsSync(destination)
    ? readManifest(manifestPath, packageName, force)
    : undefined;
  const previousFiles = previous?.files ?? {};
  const sourcePaths = new Set(sourceFiles.map((file) => file.relativePath));

  if (previous && !force) {
    validateManagedFiles(destination, previousFiles);
  }

  for (const file of sourceFiles) {
    const targetPath = managedPath(destination, file.relativePath);
    assertNoSymlinkComponents(targetPath);
    if (
      fs.existsSync(targetPath) &&
      previousFiles[file.relativePath] === undefined &&
      !force
    ) {
      throw conflict(
        `Unmanaged Skill file would be overwritten: ${file.relativePath}`,
      );
    }
  }

  for (const relativePath of Object.keys(previousFiles)) {
    if (sourcePaths.has(relativePath)) {
      continue;
    }
    const stalePath = managedPath(destination, relativePath);
    assertNoSymlinkComponents(stalePath);
    if (fs.existsSync(stalePath)) {
      if (!fs.lstatSync(stalePath).isFile()) {
        throw conflict(`Managed Skill path is not a file: ${relativePath}`);
      }
      fs.rmSync(stalePath);
    }
  }

  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const file of sourceFiles) {
    const targetPath = managedPath(destination, file.relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(targetPath);
    atomicWrite(targetPath, file.content);
  }

  const files = Object.fromEntries(
    sourceFiles.map((file) => [file.relativePath, file.hash]),
  );
  const manifest: SkillManifest = {
    schemaVersion: MANIFEST_VERSION,
    package: packageName,
    version: packageVersion,
    files,
  };
  atomicWrite(manifestPath, Buffer.from(JSON.stringify(manifest)));
}

function readSourceFiles(sourceRoot: string): SourceFile[] {
  assertNoSymlinkComponents(sourceRoot);
  if (!fs.existsSync(sourceRoot) || !fs.lstatSync(sourceRoot).isDirectory()) {
    throw new CliError(
      "SKILL_INSTALL_FAILED",
      "Skill source directory not found",
    );
  }

  const files: SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new CliError(
          "SKILL_INSTALL_FAILED",
          `Skill source contains a symlink: ${absolutePath}`,
        );
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new CliError(
          "SKILL_INSTALL_FAILED",
          `Skill source contains an unsupported entry: ${absolutePath}`,
        );
      }
      const content = fs.readFileSync(absolutePath);
      files.push({
        relativePath: normalizeRelative(
          path.relative(sourceRoot, absolutePath),
        ),
        content,
        hash: hash(content),
      });
    }
  };
  visit(sourceRoot);
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  if (!files.some((file) => file.relativePath === "SKILL.md")) {
    throw new CliError("SKILL_INSTALL_FAILED", "Skill source has no SKILL.md");
  }
  return files;
}

function readManifest(
  manifestPath: string,
  packageName: string,
  force: boolean,
): { files: ManagedFiles } | undefined {
  if (!fs.existsSync(manifestPath)) {
    if (force) {
      return undefined;
    }
    throw conflict("Existing Skill is not managed by this package");
  }

  let value: any;
  try {
    value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    if (force) {
      return undefined;
    }
    throw conflict("Installed Skill manifest is invalid");
  }
  if (value.package !== packageName) {
    if (force) {
      return undefined;
    }
    throw conflict("Existing Skill is managed by another package");
  }
  if (value.schemaVersion === MANIFEST_VERSION) {
    try {
      if (
        !value.files ||
        typeof value.files !== "object" ||
        Array.isArray(value.files)
      ) {
        throw conflict("Installed Skill manifest has invalid files");
      }
      const files: ManagedFiles = {};
      for (const [relativePath, expectedHash] of Object.entries(value.files)) {
        validateRelative(relativePath);
        if (typeof expectedHash !== "string") {
          throw conflict("Installed Skill manifest has an invalid hash");
        }
        files[relativePath] = expectedHash;
      }
      return { files };
    } catch (error) {
      if (force) {
        return undefined;
      }
      throw error;
    }
  }
  if (typeof value.hash === "string") {
    return { files: { "SKILL.md": value.hash } };
  }
  if (force) {
    return undefined;
  }
  throw conflict("Installed Skill manifest version is unsupported");
}

function validateManagedFiles(destination: string, files: ManagedFiles): void {
  for (const [relativePath, expectedHash] of Object.entries(files)) {
    const filePath = managedPath(destination, relativePath);
    assertNoSymlinkComponents(filePath);
    if (
      !fs.existsSync(filePath) ||
      !fs.lstatSync(filePath).isFile() ||
      hash(fs.readFileSync(filePath)) !== expectedHash
    ) {
      throw conflict(`Installed Skill has user modifications: ${relativePath}`);
    }
  }
}

function resolveDestinations(
  target: SkillTarget,
  home: string,
  options: InstallSkillOptions,
): InstalledSkillTarget[] {
  const targets: ConcreteSkillTarget[] =
    target === "all" ? ["agents", "codex", "claude"] : [target];
  return targets.map((value) => ({
    target: value,
    path: destinationFor(value, home, options),
  }));
}

function destinationFor(
  target: ConcreteSkillTarget,
  home: string,
  options: InstallSkillOptions,
): string {
  if (target === "agents") {
    return path.join(home, ".agents", "skills", "debug-router");
  }
  if (target === "claude") {
    return path.join(home, ".claude", "skills", "debug-router");
  }
  const configuredCodexHome =
    options.codexHome ??
    (options.home === undefined ? process.env.CODEX_HOME : undefined);
  return path.join(
    configuredCodexHome ?? path.join(home, ".codex"),
    "skills",
    "debug-router",
  );
}

function findPackageRoot(from: string): string {
  let current = from;
  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) {
      const value = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (
        value.name === "@lynx-js/debug-router-connector" &&
        fs.existsSync(path.join(current, "skills", "debug-router", "SKILL.md"))
      ) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new CliError("SKILL_INSTALL_FAILED", "Package root not found");
    }
    current = parent;
  }
}

function atomicWrite(destination: string, content: Buffer): void {
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function assertNoSymlinkComponents(target: string): void {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const components = absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;
  for (const component of components) {
    current = path.join(current, component);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new CliError(
        "SKILL_INSTALL_FAILED",
        `Skill path contains a symlink: ${current}`,
      );
    }
  }
}

function managedPath(destination: string, relativePath: string): string {
  validateRelative(relativePath);
  return path.join(destination, ...relativePath.split("/"));
}

function validateRelative(relativePath: string): void {
  if (
    !relativePath ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    relativePath
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw conflict(
      `Installed Skill manifest has an unsafe path: ${relativePath}`,
    );
  }
}

function normalizeRelative(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function hash(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function conflict(message: string): CliError {
  return new CliError("SKILL_CONFLICT", message);
}
