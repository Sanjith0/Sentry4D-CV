import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

/**
 * "Magic window" AR for browsers without WebXR (iPhone Safari): the phone's motion sensors orient
 * the camera (3-DoF), you stand life-size inside the room, and one-finger drag walks you around.
 * The camera feed is shown behind the transparent canvas by <CameraFeed/>.
 */

const zee = new THREE.Vector3(0, 0, 1);
const euler = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° about X: camera looks out the back of the device

export interface Orientation {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
}
export const orientation: Orientation = { alpha: null, beta: null, gamma: null };
let listening = false;

/** Must be called from a user gesture on iOS. */
export async function enableMotion(): Promise<boolean> {
  const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
  try {
    if (typeof DOE?.requestPermission === "function" && (await DOE.requestPermission()) !== "granted") return false;
  } catch {
    return false;
  }
  if (!listening) {
    listening = true;
    window.addEventListener("deviceorientation", (e) => {
      orientation.alpha = e.alpha;
      orientation.beta = e.beta;
      orientation.gamma = e.gamma;
    });
  }
  return true;
}

export const viewer = {
  position: new THREE.Vector3(-0.3, 1.5, -1.8),
  /** Yaw (rad) added so "recenter" faces down the room. */
  yawOffset: 0,
  recenter: false,
};

export function MagicWindowCamera() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const move = useRef(new THREE.Vector2());

  useEffect(() => {
    viewer.recenter = true;
    const el = gl.domElement;
    const down = (e: PointerEvent) => (drag.current = { x: e.clientX, y: e.clientY });
    const moveH = (e: PointerEvent) => {
      if (!drag.current) return;
      move.current.set(e.clientX - drag.current.x, e.clientY - drag.current.y);
    };
    const up = () => {
      drag.current = null;
      move.current.set(0, 0);
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", moveH);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", moveH);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [gl]);

  useFrame((_, dt) => {
    const { alpha, beta, gamma } = orientation;
    if (alpha != null && beta != null && gamma != null) {
      const screenAngle = ((screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) * Math.PI) / 180;
      const a = THREE.MathUtils.degToRad(alpha);
      if (viewer.recenter) {
        // Face down the room (−Z) from wherever the phone currently points.
        viewer.yawOffset = Math.PI - a;
        viewer.recenter = false;
      }
      euler.set(THREE.MathUtils.degToRad(beta), a + viewer.yawOffset, -THREE.MathUtils.degToRad(gamma), "YXZ");
      camera.quaternion.setFromEuler(euler);
      camera.quaternion.multiply(q1);
      camera.quaternion.multiply(q0.setFromAxisAngle(zee, -screenAngle));
    }
    // Drag = walk: up/down moves along the view heading, left/right strafes (on the floor plane).
    if (move.current.lengthSq() > 25) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
      const speed = 1.6 * Math.min(dt, 0.1); // m/s at full deflection
      viewer.position.addScaledVector(fwd, (-move.current.y / 120) * speed);
      viewer.position.addScaledVector(right, (move.current.x / 120) * speed);
      viewer.position.x = THREE.MathUtils.clamp(viewer.position.x, -2.3, 2.3);
      viewer.position.z = THREE.MathUtils.clamp(viewer.position.z, -6.6, 6.6);
    }
    camera.position.copy(viewer.position);
  });
  return null;
}

/** Rear camera feed behind the WebGL canvas. */
export function CameraFeed({ on }: { on: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false })
      .then((s) => {
        stream = s;
        if (ref.current) {
          ref.current.srcObject = s;
          void ref.current.play();
        }
      })
      .catch(() => {
        /* camera denied: the 3D scene still works */
      });
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [on]);
  if (!on) return null;
  return <video ref={ref} playsInline muted className="fixed inset-0 h-full w-full object-cover" />;
}
