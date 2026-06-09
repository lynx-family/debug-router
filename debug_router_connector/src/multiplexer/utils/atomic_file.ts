// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import path from "path";

export type AtomicWriteJsonOptions = {
  space?: number;
};

export function writeFileAtomic(
  filePath: string,
  content: string | Buffer,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const tempPath = createTempPath(filePath);
  try {
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    removeTempFile(tempPath);
    throw error;
  }
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

function createTempPath(filePath: string): string {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const suffix = `${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}`;

  return path.join(directory, `.${basename}.${suffix}.tmp`);
}

function removeTempFile(tempPath: string): void {
  try {
    fs.unlinkSync(tempPath);
  } catch (_error) {}
}
