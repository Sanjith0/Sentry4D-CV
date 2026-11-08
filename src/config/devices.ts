import type { Vec3 } from "../types/security";

/** Stable device IDs. The three laptops visible in the scan. */
export const DEVICE_IDS = ["laptop1", "laptop2", "laptop3"] as const;
export type DeviceId = (typeof DEVICE_IDS)[number];

export interface DeviceConfig {
  id: DeviceId;
  name: string;
}

export const securityDevices: DeviceConfig[] = [
  { id: "laptop1", name: "LAPTOP 01" },
  { id: "laptop2", name: "LAPTOP 02" },
  { id: "laptop3", name: "LAPTOP 03" },
];

export function getDevice(id: DeviceId | null): DeviceConfig | null {
  return securityDevices.find((d) => d.id === id) ?? null;
}

export type DevicePositions = Record<DeviceId, Vec3 | null>;
