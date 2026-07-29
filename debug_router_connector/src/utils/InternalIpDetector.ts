// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { createSocket } from "dgram";
import { isIP } from "net";
import { networkInterfaces, NetworkInterfaceInfo } from "os";
import { defaultLogger } from "./logger";

const DEFAULT_PROBE_ADDRESS = "223.5.5.5";
const PROBE_PORT = 1;
const PROBE_TIMEOUT_MS = 2000;

export type IPv4Interface = {
  /** Operating-system network interface name, such as en0 or lo0. */
  interface: string;
  /** IPv4 address assigned to this interface. */
  address: string;
  /** IPv4 address and network prefix, such as 192.168.1.10/24. */
  cidr: string;
  /** Subnet mask associated with the IPv4 address. */
  netmask: string;
  /** Whether this is an internal loopback address, such as 127.0.0.1. */
  internal: boolean;
  /** Whether this address belongs to the link-local 169.254.0.0/16 range. */
  linkLocal: boolean;
};

export type InternalIpDetectionResult = {
  target: string;
  selected: {
    address: string;
    interface?: string;
    source: "udp-route" | "interface-fallback";
    probeError?: string;
  };
  interfaces: IPv4Interface[];
};

export class InternalIpDetector {
  static async detectInternalIPv4(
    target = DEFAULT_PROBE_ADDRESS,
  ): Promise<InternalIpDetectionResult> {
    if (isIP(target) !== 4) {
      throw new Error("target must be a valid IPv4 address");
    }

    const interfaces = this.getIPv4Interfaces();

    try {
      const address = await this.findIPv4ViaUdp(target);
      return {
        target,
        selected: {
          address,
          interface: interfaces.find((item) => item.address === address)
            ?.interface,
          source: "udp-route",
        },
        interfaces,
      };
    } catch (error) {
      const probeError = (error as Error).message;
      const address = this.findFallbackIPv4FromInterfaces(interfaces);

      if (!address) {
        throw new Error(`${probeError}; no fallback IPv4 address is available`);
      }

      return {
        target,
        selected: {
          address,
          interface: interfaces.find((item) => item.address === address)
            ?.interface,
          source: "interface-fallback",
          probeError,
        },
        interfaces,
      };
    }
  }

  private static getIPv4Interfaces(): IPv4Interface[] {
    const result: IPv4Interface[] = [];

    for (const [name, addresses] of Object.entries(networkInterfaces())) {
      for (const item of addresses ?? []) {
        if (!this.isIPv4(item)) {
          continue;
        }

        result.push({
          interface: name,
          address: item.address,
          cidr: item.cidr ?? "",
          netmask: item.netmask,
          internal: item.internal,
          linkLocal: this.isLinkLocalIPv4(item.address),
        });
      }
    }

    return result;
  }

  private static isIPv4(item: NetworkInterfaceInfo): boolean {
    return item.family === "IPv4" || (item.family as unknown) === 4;
  }

  private static isLinkLocalIPv4(address: string): boolean {
    return address.startsWith("169.254.");
  }

  private static findIPv4ViaUdp(remoteAddress: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createSocket("udp4");
      let completed = false;

      const finish = (error?: Error, address?: string): void => {
        if (completed) {
          return;
        }

        completed = true;
        clearTimeout(timer);
        socket.close();

        if (error) {
          reject(error);
        } else if (address) {
          resolve(address);
        } else {
          reject(new Error("The UDP route probe returned no address"));
        }
      };

      const timer = setTimeout(() => {
        finish(
          new Error(`UDP route probe timed out after ${PROBE_TIMEOUT_MS} ms`),
        );
      }, PROBE_TIMEOUT_MS);

      socket.unref();
      socket.once("error", (error: Error) => finish(error));

      try {
        socket.connect(PROBE_PORT, remoteAddress, () => {
          const localAddress = socket.address().address;
          if (!localAddress || localAddress === "0.0.0.0") {
            finish(
              new Error(
                "The operating system did not select a local IPv4 address",
              ),
            );
            return;
          }

          finish(undefined, localAddress);
        });
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  private static findFallbackIPv4FromInterfaces(
    interfaces: IPv4Interface[],
  ): string | undefined {
    const candidates = interfaces.filter(
      (item) => !item.internal && !item.linkLocal,
    );
    const interfaceNames = new Set(candidates.map((item) => item.interface));

    if (interfaceNames.size > 1) {
      defaultLogger.warn(
        `[internal-ip] Multiple IPv4 interfaces found; selecting the first candidate: ${JSON.stringify(
          candidates,
          null,
          2,
        )}`,
      );
    }

    return candidates[0]?.address;
  }
}
