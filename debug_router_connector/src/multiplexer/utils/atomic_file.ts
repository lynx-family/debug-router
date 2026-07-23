// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import path from "path";

type WriteFileAtomicPackage = {
  sync: (filename: string, data: string | Buffer) => void;
};

const writeFileAtomicPackage = require("write-file-atomic") as WriteFileAtomicPackage;
const RETRIABLE_ATOMIC_WRITE_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EPERM",
]);
const ATOMIC_WRITE_RETRY_DELAYS_MS = [10, 20, 40];

export type AtomicWriteJsonOptions = {
  space?: number;
};

// Using `write-file-atomic` write file on Windows can sometimes fail because 
// the file is in use or cannot be replaced. Adding a limited retry for those
// specific errors here should address these intermittent failures.

export function writeFileAtomic(
  filePath: string,
  content: string | Buffer,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  for (
    let attempt = 0;
    attempt <= ATOMIC_WRITE_RETRY_DELAYS_MS.length;
    attempt++
  ) {
    try {
      writeFileAtomicPackage.sync(filePath, content);
      return;
    } catch (error) {
      if (
        !isRetriableAtomicWriteError(error) ||
        attempt === ATOMIC_WRITE_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      sleepSync(ATOMIC_WRITE_RETRY_DELAYS_MS[attempt]);
    }
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

function isRetriableAtomicWriteError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    RETRIABLE_ATOMIC_WRITE_ERROR_CODES.has(
      (error as { code?: string }).code ?? "",
    )
  );
}

function sleepSync(durationMs: number): void {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {}
}
