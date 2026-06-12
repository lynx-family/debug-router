// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import fs from "fs";
import {
  MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION,
  MULTIPLEXER_PROTOCOL_VERSION,
  MultiplexerDiscoveryInfo,
} from "../protocol/discovery";
import { isMultiplexerDiscoveryInfo, isRecord } from "../protocol/validation";

export type MultiplexerDiscoveryOption = {
  discoveryPath: string;
  staleTimeout: number;
  localProtocolVersion?: number;
  now?: () => number;
};

export type MultiplexerProtocolCompatibility =
  | {
      status: "compatible";
      reason: "same-version" | "daemon-newer-compatible";
      daemonProtocolVersion: number;
      connectorProtocolVersion: number;
    }
  | {
      status: "replace-required";
      reason: "daemon-older-than-connector";
      daemonProtocolVersion: number;
      connectorProtocolVersion: number;
    }
  | {
      status: "incompatible";
      reason: "connector-older-than-daemon-min-supported";
      daemonProtocolVersion: number;
      daemonMinSupportedProtocolVersion: number;
      connectorProtocolVersion: number;
    };

export type MultiplexerDiscoveryValidation =
  | {
      status: "usable";
      info: MultiplexerDiscoveryInfo;
      compatibility: Extract<
        MultiplexerProtocolCompatibility,
        { status: "compatible" }
      >;
    }
  | {
      status: "replace-required";
      info: MultiplexerDiscoveryInfo;
      compatibility: Extract<
        MultiplexerProtocolCompatibility,
        { status: "replace-required" }
      >;
    }
  | {
      status: "unusable";
      reason: "connector-protocol-too-old";
      info: MultiplexerDiscoveryInfo;
      compatibility: Extract<
        MultiplexerProtocolCompatibility,
        { status: "incompatible" }
      >;
    }
  | {
      status: "unusable";
      reason:
        | "missing"
        | "invalid-json"
        | "invalid-shape"
        | "stale"
        | "missing-protocol-version";
      info?: MultiplexerDiscoveryInfo;
    };

type DiscoveryReadResult =
  | {
      status: "loaded";
      value: unknown;
    }
  | {
      status: "missing" | "invalid-json";
    };

export class MultiplexerDiscovery {
  readonly discoveryPath: string;
  readonly localProtocolVersion: number;
  readonly staleTimeout: number;
  private readonly now: () => number;

  constructor(option: MultiplexerDiscoveryOption) {
    this.discoveryPath = option.discoveryPath;
    this.localProtocolVersion =
      option.localProtocolVersion ?? MULTIPLEXER_PROTOCOL_VERSION;
    this.staleTimeout = option.staleTimeout ?? 5000;
    this.now = option.now ?? Date.now;
  }

  readDiscovery(): MultiplexerDiscoveryInfo | null {
    const readResult = this.readDiscoveryFile();

    if (
      readResult.status === "loaded" &&
      isMultiplexerDiscoveryInfo(readResult.value)
    ) {
      return readResult.value;
    }

    return null;
  }

  validateDiscovery(
    info?: MultiplexerDiscoveryInfo | null,
  ): MultiplexerDiscoveryValidation {
    if (arguments.length === 0) {
      return this.validateReadResult(this.readDiscoveryFile());
    }

    if (info === null || info === undefined) {
      return { status: "unusable", reason: "missing" };
    }

    return this.validateValue(info);
  }

  compareProtocolVersion(
    info: MultiplexerDiscoveryInfo,
  ): MultiplexerProtocolCompatibility {
    const daemonMinSupportedProtocolVersion =
      info.minSupportedProtocolVersion ??
      MULTIPLEXER_MIN_SUPPORTED_PROTOCOL_VERSION;

    if (this.localProtocolVersion < daemonMinSupportedProtocolVersion) {
      return {
        status: "incompatible",
        reason: "connector-older-than-daemon-min-supported",
        daemonProtocolVersion: info.protocolVersion,
        daemonMinSupportedProtocolVersion,
        connectorProtocolVersion: this.localProtocolVersion,
      };
    }

    if (info.protocolVersion < this.localProtocolVersion) {
      return {
        status: "replace-required",
        reason: "daemon-older-than-connector",
        daemonProtocolVersion: info.protocolVersion,
        connectorProtocolVersion: this.localProtocolVersion,
      };
    }

    return {
      status: "compatible",
      reason:
        info.protocolVersion === this.localProtocolVersion
          ? "same-version"
          : "daemon-newer-compatible",
      daemonProtocolVersion: info.protocolVersion,
      connectorProtocolVersion: this.localProtocolVersion,
    };
  }

  isFresh(info: MultiplexerDiscoveryInfo): boolean {
    return this.now() - info.heartbeat <= this.staleTimeout;
  }

  getFreshDiscovery(): MultiplexerDiscoveryInfo | null {
    const validation = this.validateDiscovery();
    return validation.status === "usable" ? validation.info : null;
  }

  getReusableDiscovery(): MultiplexerDiscoveryInfo | null {
    const validation = this.validateDiscovery();
    return validation.status === "usable" ? validation.info : null;
  }

  private validateReadResult(
    readResult: DiscoveryReadResult,
  ): MultiplexerDiscoveryValidation {
    switch (readResult.status) {
      case "missing":
        return { status: "unusable", reason: "missing" };
      case "invalid-json":
        return { status: "unusable", reason: "invalid-json" };
      case "loaded":
        return this.validateValue(readResult.value);
    }
  }

  private validateValue(value: unknown): MultiplexerDiscoveryValidation {
    if (!isRecord(value)) {
      return { status: "unusable", reason: "invalid-shape" };
    }

    if (!Object.prototype.hasOwnProperty.call(value, "protocolVersion")) {
      return { status: "unusable", reason: "missing-protocol-version" };
    }

    if (!isMultiplexerDiscoveryInfo(value)) {
      return { status: "unusable", reason: "invalid-shape" };
    }

    if (!this.isFresh(value)) {
      return { status: "unusable", reason: "stale", info: value };
    }

    const compatibility = this.compareProtocolVersion(value);
    if (compatibility.status === "incompatible") {
      return {
        status: "unusable",
        reason: "connector-protocol-too-old",
        info: value,
        compatibility,
      };
    }

    if (compatibility.status === "replace-required") {
      return {
        status: "replace-required",
        info: value,
        compatibility,
      };
    }

    return {
      status: "usable",
      info: value,
      compatibility,
    };
  }

  private readDiscoveryFile(): DiscoveryReadResult {
    if (!fs.existsSync(this.discoveryPath)) {
      return { status: "missing" };
    }

    try {
      return {
        status: "loaded",
        value: JSON.parse(fs.readFileSync(this.discoveryPath, "utf8")),
      };
    } catch (_error) {
      return { status: "invalid-json" };
    }
  }
}
