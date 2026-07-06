// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import path from "path";

type WriteFileAtomicPackage = {
  sync: (filename: string, data: string | Buffer) => void;
};

const writeFileAtomicPackage = require("write-file-atomic") as WriteFileAtomicPackage;

export type AtomicWriteJsonOptions = {
  space?: number;
};

export function writeFileAtomic(
  filePath: string,
  content: string | Buffer,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileAtomicPackage.sync(filePath, content);
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteJsonOptions = {},
): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, options.space ?? 2));
}

export function readJsonFile<T = unknown>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function removeFileIfExists(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}
