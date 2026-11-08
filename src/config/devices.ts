import type { Vec3 } from "../types/security";

/**
 * Stable device IDs: the three laptops visible in the scan. These match the
 * `asset_id` values the BLACKSITE agent-worker (services/agent-worker) uses,
 * so a cyber alert's assetId maps straight onto a marker with no translation
 * table. "laptop-b" is the only one with an authored training scenario today
 * (see services/agent-worker/blacksite_agent/fixtures.py); "laptop-a" exists
 * as a backend asset with no scenario yet; "laptop-c" has neither yet.
 */
export const DEVICE_IDS = ["laptop-a", "laptop-b", "laptop-c"] as const;
export type DeviceId = (typeof DEVICE_IDS)[number];

export interface DeviceConfig {
  id: DeviceId;
  name: string;
}

export const securityDevices: DeviceConfig[] = [
  { id: "laptop-a", name: "LAPTOP A" },
  { id: "laptop-b", name: "LAPTOP B" },
  { id: "laptop-c", name: "LAPTOP C" },
];

export function getDevice(id: DeviceId | null): DeviceConfig | null {
  return securityDevices.find((d) => d.id === id) ?? null;
}

export type DevicePositions = Record<DeviceId, Vec3 | null>;
