import { create } from "zustand";
import devicePositionsJson from "../../config/device-positions.json";
import { DEVICE_IDS, type DeviceId, type DevicePositions } from "../../config/devices";
import type { Vec3 } from "../../types/security";

function loadSaved(): DevicePositions {
  const raw = devicePositionsJson as Record<string, Vec3 | null>;
  return DEVICE_IDS.reduce((acc, id) => {
    acc[id] = raw[id] ?? null;
    return acc;
  }, {} as DevicePositions);
}

export function positionsEqual(a: Vec3 | null, b: Vec3 | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

interface DeviceState {
  positions: DevicePositions;
  savedPositions: DevicePositions;
  /** Which device the next room click will place. Null = placement mode off. */
  placingDeviceId: DeviceId | null;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  setPlacing: (id: DeviceId | null) => void;
  setPosition: (id: DeviceId, position: Vec3) => void;
  revertPosition: (id: DeviceId) => void;
  markSaved: () => void;
}

export const useDeviceStore = create<DeviceState>()((set) => {
  const saved = loadSaved();
  return {
    positions: { ...saved },
    savedPositions: saved,
    placingDeviceId: null,
    panelOpen: false,
    setPanelOpen: (panelOpen) => set((s) => ({ panelOpen, placingDeviceId: panelOpen ? s.placingDeviceId : null })),
    setPlacing: (placingDeviceId) => set({ placingDeviceId }),
    setPosition: (id, position) => set((s) => ({ positions: { ...s.positions, [id]: position }, placingDeviceId: null })),
    revertPosition: (id) => set((s) => ({ positions: { ...s.positions, [id]: s.savedPositions[id] } })),
    markSaved: () => set((s) => ({ savedPositions: { ...s.positions } })),
  };
});
