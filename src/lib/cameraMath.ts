import * as THREE from "three";
import type { CameraPoseConfig, Vec3 } from "../types/security";
import { CCTV_ASPECT } from "../config/cctv";

const DEG = Math.PI / 180;

/** World orientation of a camera pose (looks down its local -Z, like a THREE camera). */
export function poseQuaternion(p: Pick<CameraPoseConfig, "yaw" | "pitch" | "roll">, out = new THREE.Quaternion()) {
  return out.setFromEuler(new THREE.Euler(p.pitch * DEG, p.yaw * DEG, p.roll * DEG, "YXZ"));
}

export function poseForward(p: Pick<CameraPoseConfig, "yaw" | "pitch">): Vec3 {
  const cp = Math.cos(p.pitch * DEG);
  return [-Math.sin(p.yaw * DEG) * cp, Math.sin(p.pitch * DEG), -Math.cos(p.yaw * DEG) * cp];
}

export function poseTarget(p: CameraPoseConfig, distance = 3): Vec3 {
  const f = poseForward(p);
  return [p.position[0] + f[0] * distance, p.position[1] + f[1] * distance, p.position[2] + f[2] * distance];
}

/** Yaw/pitch (degrees) that look from `position` toward `target`. */
export function lookAngles(position: Vec3, target: Vec3) {
  const dx = target[0] - position[0];
  const dy = target[1] - position[1];
  const dz = target[2] - position[2];
  return { yaw: Math.atan2(-dx, -dz) / DEG, pitch: Math.atan2(dy, Math.hypot(dx, dz)) / DEG };
}

/**
 * The 16:9 sensor frame fitted inside a viewport (letterboxed), in CSS px.
 * The virtual view is rendered so this box matches the real recording's framing.
 */
export function sensorBox(width: number, height: number) {
  const aspect = width / Math.max(height, 1);
  if (aspect < CCTV_ASPECT) {
    const h = width / CCTV_ASPECT;
    return { x: 0, y: (height - h) / 2, w: width, h };
  }
  const w = height * CCTV_ASPECT;
  return { x: (width - w) / 2, y: 0, w, h: height };
}

/** Vertical FOV for the whole viewport so that the sensor box shows exactly `fov`. */
export function viewportFov(fov: number, width: number, height: number) {
  const box = sensorBox(width, height);
  return (2 * Math.atan(Math.tan((fov * DEG) / 2) * (height / box.h))) / DEG;
}

export const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
