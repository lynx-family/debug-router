// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const fs = require("fs");
const path = require("path");

const ts = require(require.resolve("typescript", {
  paths: [path.join(__dirname, "../../../debug_router_connector")],
}));

require.extensions[".ts"] = function registerTypescript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
    fileName: filename,
  }).outputText;

  module._compile(output, filename);
};
