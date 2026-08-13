// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { createConnection } from "net";
import {
  MultiplexerDebugInfo,
  MultiplexerHealthRequest,
  MultiplexerHealthResponse,
  isMultiplexerHandshakeErrorResponse,
  isMultiplexerHealthResponse,
} from "../protocol";
import {
  MultiplexerControlTransport,
  MultiplexerControlTransportError,
} from "../transport/MultiplexerControlTransport";

export const DEFAULT_MULTIPLEXER_HEALTH_CHECK_TIMEOUT = 500;

export type MultiplexerDiscoveryOption = {
  controlEndpoint: string;
  localProtocolVersion: number;
  healthCheckTimeout?: number;
  debugInfo?: MultiplexerDebugInfo;

  // only used for tests or embedding
  now?: () => number;
};

export type MultiplexerDiscoveryValidation =
  | {
      status: "usable";
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
      status: "unusable";
      reason: "daemon-upgrade-blocked-by-active-connections";
      daemonProtocolVersion: number;
      connectorProtocolVersion: number;
    }
  | {
      status: "unusable";
      reason: "unreachable" | "timeout" | "invalid-frame" | "invalid-response";
      error?: Error;
    };

export class MultiplexerDiscovery {
  readonly controlEndpoint: string;
  readonly localProtocolVersion: number;
  readonly healthCheckTimeout: number;

  private readonly debugInfo?: MultiplexerDebugInfo;
  private readonly now: () => number;

  constructor(option: MultiplexerDiscoveryOption) {
    this.controlEndpoint = option.controlEndpoint;
    this.localProtocolVersion = option.localProtocolVersion;
    this.healthCheckTimeout =
      option.healthCheckTimeout ?? DEFAULT_MULTIPLEXER_HEALTH_CHECK_TIMEOUT;
    this.debugInfo = option.debugInfo;
    this.now = option.now ?? Date.now;
  }

  async probeHealth(): Promise<MultiplexerDiscoveryValidation> {
    return new Promise((resolve) => {
      const transport = new MultiplexerControlTransport(
        createConnection(this.controlEndpoint),
      );
      let settled = false;

      const finish = (result: MultiplexerDiscoveryValidation): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unsubscribeConnect();
        unsubscribeMessage();
        unsubscribeClose();
        void transport.end();
        resolve(result);
      };

      const handleConnect = (): void => {
        const debugInfo = this.createDebugInfo();
        const request: MultiplexerHealthRequest = {
          kind: "health",
          ...(debugInfo ? { debugInfo } : {}),
        };
        try {
          transport.send(request);
        } catch (error) {
          finish({
            status: "unusable",
            reason: "unreachable",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      };

      const unsubscribeMessage = transport.onMessage((message) => {
        if (isMultiplexerHandshakeErrorResponse(message)) {
          const error = new Error(message.error.message);
          error.name = message.error.code;
          finish({ status: "unusable", reason: "invalid-response", error });
          return;
        }
        if (!isMultiplexerHealthResponse(message)) {
          finish({ status: "unusable", reason: "invalid-response" });
          return;
        }
        finish(this.compareProtocolVersion(message));
      });
      const unsubscribeClose = transport.onClose((error) => {
        finish({
          status: "unusable",
          reason:
            error instanceof MultiplexerControlTransportError
              ? "invalid-frame"
              : "unreachable",
          ...(error ? { error } : {}),
        });
      });
      const timer = setTimeout(() => {
        finish({ status: "unusable", reason: "timeout" });
      }, this.healthCheckTimeout);

      const unsubscribeConnect = transport.onConnect(handleConnect);
    });
  }

  compareProtocolVersion(
    response: MultiplexerHealthResponse,
  ): MultiplexerDiscoveryValidation {
    if (response.protocolVersion < this.localProtocolVersion) {
      if (response.isInUse) {
        return {
          status: "unusable",
          reason: "daemon-upgrade-blocked-by-active-connections",
          daemonProtocolVersion: response.protocolVersion,
          connectorProtocolVersion: this.localProtocolVersion,
        };
      }
      return {
        status: "replace-required",
        reason: "daemon-older-than-connector",
        daemonProtocolVersion: response.protocolVersion,
        connectorProtocolVersion: this.localProtocolVersion,
      };
    }

    return {
      status: "usable",
      reason:
        response.protocolVersion === this.localProtocolVersion
          ? "same-version"
          : "daemon-newer-compatible",
      daemonProtocolVersion: response.protocolVersion,
      connectorProtocolVersion: this.localProtocolVersion,
    };
  }

  private createDebugInfo(): MultiplexerDebugInfo | undefined {
    if (!this.debugInfo) {
      return undefined;
    }
    return {
      ...this.debugInfo,
      protocolVersion:
        this.debugInfo.protocolVersion ?? this.localProtocolVersion,
      processId: process.pid,
      timestamp: this.now(),
    };
  }
}
