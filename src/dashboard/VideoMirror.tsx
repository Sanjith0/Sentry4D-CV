import { useEffect, useRef } from "react";
import { videoRegistry } from "../lib/videoRegistry";
import type { CameraId } from "../types/security";

/**
 * Draws a camera's live <video> onto a canvas every frame. Lets us show the same
 * recording larger (enlarged feed, sync preview) without a second decoder and
 * without moving the element in the DOM. Always shows exactly what the synced
 * feed shows.
 */
export function VideoMirror({ cameraId, rotation = 0, className = "" }: { cameraId: CameraId; rotation?: number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let lastT = -1;
    let lastW = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.max(1, Math.round(c.clientWidth * dpr));
      c.height = Math.max(1, Math.round(c.clientHeight * dpr));
      lastT = -1;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(c);
    resize();

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const v = videoRegistry.get(cameraId);
      if (!v || v.readyState < 2 || !v.videoWidth) return;
      // Redraw only when the frame changed (or canvas resized).
      if (v.currentTime === lastT && c.width === lastW && v.paused) return;
      lastT = v.currentTime;
      lastW = c.width;
      // Letterbox ("contain") the video into the canvas.
      const rotated = rotation % 180 !== 0;
      const vw = rotated ? v.videoHeight : v.videoWidth;
      const vh = rotated ? v.videoWidth : v.videoHeight;
      const scale = Math.min(c.width / vw, c.height / vh);
      const w = vw * scale;
      const h = vh * scale;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.save();
      ctx.translate(c.width / 2, c.height / 2);
      if (rotation) ctx.rotate((rotation * Math.PI) / 180);
      const [dw, dh] = rotated ? [h, w] : [w, h];
      ctx.drawImage(v, -dw / 2, -dh / 2, dw, dh);
      ctx.restore();
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [cameraId, rotation]);

  return <canvas ref={canvas} className={`block h-full w-full ${className}`} />;
}
