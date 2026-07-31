const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { installSkill } = require("../../dist/cjs/src/cli/installSkill.js");

describe("installSkill", () => {
  let root;
  let home;
  let packageRoot;
  let source;

  beforeEach(() => {
    root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "debug-router-skill-"),
    );
    home = path.join(root, "home");
    packageRoot = path.join(root, "package");
    source = path.join(packageRoot, "skills", "debug-router");
    fs.mkdirSync(path.join(source, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@lynx-js/debug-router-connector",
        version: "1.0.0",
      }),
    );
    fs.writeFileSync(
      path.join(source, "SKILL.md"),
      "---\nname: debug-router\n---\nbody\n",
    );
    fs.writeFileSync(
      path.join(source, "agents", "openai.yaml"),
      'interface:\n  display_name: "Debug Router"\n',
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function destination(target = "agents") {
    const rootName = {
      agents: ".agents",
      codex: ".codex",
      claude: ".claude",
    }[target];
    return path.join(home, rootName, "skills", "debug-router");
  }

  it("defaults to the shared Agents directory and installs every Skill file", () => {
    const result = installSkill({ home, packageRoot });
    const installed = destination();
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(installed, ".debug-router-connector.json"),
        "utf8",
      ),
    );

    assert.deepStrictEqual(result, {
      installed: true,
      path: installed,
      target: "agents",
      targets: [{ target: "agents", path: installed }],
      legacyCopies: [],
      version: "1.0.0",
    });
    assert.strictEqual(
      fs.readFileSync(path.join(installed, "agents", "openai.yaml"), "utf8"),
      fs.readFileSync(path.join(source, "agents", "openai.yaml"), "utf8"),
    );
    assert.strictEqual(manifest.schemaVersion, 2);
    assert.deepStrictEqual(Object.keys(manifest.files).sort(), [
      "SKILL.md",
      "agents/openai.yaml",
    ]);
  });

  it("supports explicit targets and all targets", () => {
    const codexHome = path.join(root, "custom-codex");
    const codex = installSkill({
      home,
      codexHome,
      packageRoot,
      target: "codex",
    });
    assert.strictEqual(
      codex.path,
      path.join(codexHome, "skills", "debug-router"),
    );

    const all = installSkill({
      home,
      codexHome,
      packageRoot,
      target: "all",
    });
    assert.deepStrictEqual(
      all.targets.map(({ target }) => target),
      ["agents", "codex", "claude"],
    );
    for (const installed of all.targets) {
      assert.strictEqual(
        fs.existsSync(path.join(installed.path, "SKILL.md")),
        true,
      );
    }
  });

  it("reports but does not modify a legacy Claude copy", () => {
    const legacy = destination("claude");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "SKILL.md"), "legacy user copy\n");

    const result = installSkill({ home, packageRoot });

    assert.deepStrictEqual(result.legacyCopies, [legacy]);
    assert.strictEqual(
      fs.readFileSync(path.join(legacy, "SKILL.md"), "utf8"),
      "legacy user copy\n",
    );
  });

  it("installs and updates a managed unmodified Skill", () => {
    installSkill({ home, packageRoot });
    fs.writeFileSync(path.join(source, "SKILL.md"), "new body\n");
    installSkill({ home, packageRoot });
    assert.strictEqual(
      fs.readFileSync(path.join(destination(), "SKILL.md"), "utf8"),
      "new body\n",
    );
  });

  it("protects user changes unless forced and preserves unrelated files", () => {
    installSkill({ home, packageRoot });
    const installed = destination();
    fs.writeFileSync(path.join(installed, "SKILL.md"), "user edit\n");
    fs.writeFileSync(path.join(installed, "notes.txt"), "keep");

    assert.throws(() => installSkill({ home, packageRoot }), /SKILL_CONFLICT/);
    installSkill({ home, packageRoot, force: true });
    assert.strictEqual(
      fs.readFileSync(path.join(installed, "notes.txt"), "utf8"),
      "keep",
    );
    assert.strictEqual(
      fs.readFileSync(path.join(installed, "SKILL.md"), "utf8"),
      fs.readFileSync(path.join(source, "SKILL.md"), "utf8"),
    );
  });

  it("rejects an unmanaged destination unless forced", () => {
    const installed = destination();
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "SKILL.md"), "unknown");

    assert.throws(() => installSkill({ home, packageRoot }), /SKILL_CONFLICT/);
    installSkill({ home, packageRoot, force: true });
    assert.strictEqual(
      fs.readFileSync(path.join(installed, "SKILL.md"), "utf8"),
      fs.readFileSync(path.join(source, "SKILL.md"), "utf8"),
    );
  });

  it("migrates a version-one manifest to version two", () => {
    const installed = destination();
    const skillContent = fs.readFileSync(path.join(source, "SKILL.md"));
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "SKILL.md"), skillContent);
    fs.writeFileSync(
      path.join(installed, ".debug-router-connector.json"),
      JSON.stringify({
        package: "@lynx-js/debug-router-connector",
        version: "0.9.0",
        hash: crypto.createHash("sha256").update(skillContent).digest("hex"),
      }),
    );

    installSkill({ home, packageRoot });

    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(installed, ".debug-router-connector.json"),
        "utf8",
      ),
    );
    assert.strictEqual(manifest.schemaVersion, 2);
    assert.deepStrictEqual(Object.keys(manifest.files).sort(), [
      "SKILL.md",
      "agents/openai.yaml",
    ]);
  });

  it("removes stale managed files but retains modified ones without force", () => {
    const obsoleteSource = path.join(source, "obsolete.txt");
    fs.writeFileSync(obsoleteSource, "old\n");
    installSkill({ home, packageRoot });
    fs.rmSync(obsoleteSource);
    installSkill({ home, packageRoot });
    assert.strictEqual(
      fs.existsSync(path.join(destination(), "obsolete.txt")),
      false,
    );

    fs.writeFileSync(obsoleteSource, "old again\n");
    installSkill({ home, packageRoot });
    fs.rmSync(obsoleteSource);
    fs.writeFileSync(path.join(destination(), "obsolete.txt"), "user edit\n");
    assert.throws(() => installSkill({ home, packageRoot }), /SKILL_CONFLICT/);
    installSkill({ home, packageRoot, force: true });
    assert.strictEqual(
      fs.existsSync(path.join(destination(), "obsolete.txt")),
      false,
    );
  });

  it("rejects symlinks in Skill sources and destination paths", () => {
    const sourceLink = path.join(source, "linked.txt");
    fs.symlinkSync(path.join(source, "SKILL.md"), sourceLink);
    assert.throws(
      () => installSkill({ home, packageRoot }),
      /SKILL_INSTALL_FAILED/,
    );
    fs.rmSync(sourceLink);

    const realHome = path.join(root, "real-home");
    const linkedHome = path.join(root, "linked-home");
    fs.mkdirSync(realHome);
    fs.symlinkSync(realHome, linkedHome);
    assert.throws(
      () => installSkill({ home: linkedHome, packageRoot }),
      /SKILL_INSTALL_FAILED/,
    );
  });
});
