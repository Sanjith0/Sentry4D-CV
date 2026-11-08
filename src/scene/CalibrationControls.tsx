import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { useReplayStore } from "../store/useReplayStore";
import { round, sensorBox } from "../lib/cameraMath";
import type { CameraId, CameraPoseConfig } from "../types/security";

const DEG = Math.PI / 180;

/** Apply a relative change to the selected camera's live pose. */
export function nudgePose(id: CameraId, f: (p: CameraPoseConfig) => Partial<CameraPoseConfig>) {
  const s = useReplayStore.getState();
  const cur = s.cameraPoses[id];
  const patch = f(cur);
  const clean: Partial<CameraPoseConfig> = {};
  if (patch.position) clean.position = patch.position.map((v) => round(v, 3)) as CameraPoseConfig["position"];
  if (patch.yaw !== undefined) clean.yaw = round(((((patch.yaw + 180) % 360) + 360) % 360) - 180, 2);
  if (patch.pitch !== undefined) clean.pitch = round(Math.min(Math.max(patch.pitch, -89), 89), 2);
  if (patch.roll !== undefined) clean.roll = round(Math.min(Math.max(patch.roll, -90), 90), 2);
  if (patch.fov !== undefined) clean.fov = round(Math.min(Math.max(patch.fov, 10), 140), 2);
  s.setCameraPose(id, clean);
}

/** Move in the camera's horizontal frame: forward/back along its heading, strafe, and world up/down. */
export function moveRelative(id: CameraId, forward: number, right: number, up: number) {
  nudgePose(id, (p) => {
    const y = p.yaw * DEG;
    const fx = -Math.sin(y);
    const fz = -Math.cos(y);
    const rx = Math.cos(y);
    const rz = -Math.sin(y);
    return {
      position: [p.position[0] + fx * forward + rx * right, p.position[1] + up, p.position[2] + fz * forward + rz * right],
    };
  });
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

/**
 * Mouse/keyboard calibration for the selected CCTV camera (mounted only while calibrating).
 * Drag = aim (pan/tilt), wheel = FOV, WASD = move, Q/E = down/up, arrows = pan/tilt,
 * [ ] = FOV, , . = roll. Hold Shift for fine steps.
 */
export function CalibrationControls() {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);

  useEffect(() => {
    const el = gl.domElement;
    const id = () => useReplayStore.getState().selectedCameraId;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      const cam = id();
      if (!dragging || !cam) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      // Degrees per pixel so the image tracks the cursor; Shift = 5× finer.
      const pose = useReplayStore.getState().cameraPoses[cam];
      const k = (pose.fov / sensorBox(size.width, size.height).h) * (e.shiftKey ? 0.2 : 1);
      nudgePose(cam, (p) => ({ yaw: p.yaw + dx * k, pitch: p.pitch + dy * k }));
    };
    const onUp = (e: PointerEvent) => {
      dragging = false;
      el.style.cursor = "";
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      const cam = id();
      if (!cam) return;
      e.preventDefault();
      const step = e.shiftKey ? 0.1 : 0.5;
      nudgePose(cam, (p) => ({ fov: p.fov + (e.deltaY > 0 ? step : -step) }));
    };
    const onKey = (e: KeyboardEvent) => {
      const cam = id();
      if (!cam || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const fine = e.shiftKey;
      const m = fine ? 0.01 : 0.05; // meters
      const a = fine ? 0.1 : 1; // degrees
      let handled = true;
      switch (e.code) {
        case "KeyW": moveRelative(cam, m, 0, 0); break;
        case "KeyS": moveRelative(cam, -m, 0, 0); break;
        case "KeyD": moveRelative(cam, 0, m, 0); break;
        case "KeyA": moveRelative(cam, 0, -m, 0); break;
        case "KeyE": moveRelative(cam, 0, 0, m); break;
        case "KeyQ": moveRelative(cam, 0, 0, -m); break;
        case "ArrowLeft": nudgePose(cam, (p) => ({ yaw: p.yaw + a })); break;
        case "ArrowRight": nudgePose(cam, (p) => ({ yaw: p.yaw - a })); break;
        case "ArrowUp": nudgePose(cam, (p) => ({ pitch: p.pitch + a })); break;
        case "ArrowDown": nudgePose(cam, (p) => ({ pitch: p.pitch - a })); break;
        case "BracketLeft": nudgePose(cam, (p) => ({ fov: p.fov - a })); break;
        case "BracketRight": nudgePose(cam, (p) => ({ fov: p.fov + a })); break;
        case "Comma": nudgePose(cam, (p) => ({ roll: p.roll + a })); break;
        case "Period": nudgePose(cam, (p) => ({ roll: p.roll - a })); break;
        default: handled = false;
      }
      if (handled) {
        // Capture phase on window: keep the global shortcuts (e.g. arrows = seek) from also firing.
        e.preventDefault();
        e.stopPropagation();
      }
    };

    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey, { capture: true });
      el.style.cursor = "";
    };
  }, [gl, size.width, size.height]);

  return null;
}
