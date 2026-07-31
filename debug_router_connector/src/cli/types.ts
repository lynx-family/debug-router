export type CliPlatform = "android" | "ios" | "harmony" | "desktop";

export type DeviceOutput = {
  id: string;
  platform: string;
  name: string;
};

export type ClientOutput = {
  id: string;
  deviceId: string;
  platform: string;
  port: number;
  app: string;
  sdkVersion: string;
};

export type ListOutput = {
  devices: DeviceOutput[];
  clients: ClientOutput[];
};

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(`${code}: ${message}`);
  }
}
