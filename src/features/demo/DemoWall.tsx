import { useEffect, useRef } from "react";
import { securityCameras } from "../../config/cameras";
import { subjects } from "../../config/subjects";
import { formatClock } from "../../lib/format";
import { videoRegistry } from "../../lib/videoRegistry";
import { useReplayStore } from "../../store/useReplayStore";
import type { CameraId } from "../../types/security";
import { peekTexture, useAppearanceStore } from "../reconstruction/useAppearanceStore";
import { CCTV_ASPECT } from "../../config/cctv";
import { DEMO_CLIP, DEMO_SUBJECT, easeOut, footageBand, lerp, tilePower, wallAt } from "./demoScript";
import { useDemoStore } from "./useDemoStore";

const INK = "#04070c";
const CYAN = "#22d3ee";
const MONO = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace';
const subjectLabel = subjects.find((s) => s.id === DEMO_SUBJECT)?.label ?? "PERSON 01";

/** Source rectangle of a w x h picture that fills a tile of the given aspect edge to edge (cover fit). */
function coverRect(w: number, h: number, aspect: number) {
  if (aspect > w / h) {
    const sh = w / aspect;
    return { sx: 0, sy: (h - sh) / 2, sw: w, sh };
  }
  const sw = h * aspect;
  return { sx: (w - sw) / 2, sy: 0, sw, sh: h };
}

/** Per camera: the subject's cut-out as a flat cyan silhouette (for the X-ray tint). */
const tints = new Map<CameraId, HTMLCanvasElement>();
function silhouette(id: CameraId, img: CanvasImageSource & { width: number; height: number }) {
  let c = tints.get(id);
  if (!c) tints.set(id, (c = document.createElement("canvas")));
  if (c.width !== img.width || c.height !== img.height) {
    c.width = img.width;
    c.height = img.height;
  }
  const g = c.getContext("2d")!;
  g.globalCompositeOperation = "source-over";
  g.clearRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = CYAN;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

/**
 * The opening of the demo walkthrough: the four recordings as a CCTV wall (the same <video> elements the
 * feed panel plays), the subject's SAM 2.1 cut-out lit in each, then a push into CAM 01 until it fills the
 * screen and fades ("real footage" 100% → 0%) onto the 3D viewport underneath, which shows the same view.
 */
export function DemoWall() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = useDemoStore.getState();
      const e = s.elapsed;
      const wall = wallAt(e);
      // Already there (dark, behind the loading card) while the demo prepares: the frame in which the card
      // goes must not show the bare viewport underneath.
      const show = s.phase !== "idle" && wall.visible;
      el.style.display = show ? "block" : "none";
      if (!show) return;
      el.style.opacity = String(wall.footage);

      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) {
        el.width = Math.round(W * dpr);
        el.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = INK;
      ctx.fillRect(0, 0, W, H);

      // 2x2 tiles with the viewport's own aspect, so tile 1 can grow into the full screen without a jump.
      // (Room is left above for the demo's top bar and below for its caption.)
      // Portrait window: the four 16:9 pictures in one column; tile 1 grows into the band the recording
      // takes in the opened-up viewport (footageBand), changing its shape on the way.
      const replay = useReplayStore.getState();
      const aspect = W / H;
      const portrait = aspect < 1;
      const cols = portrait ? 1 : 2;
      const top0 = 0.08 * H;
      const gy = 0.02 * H;
      const gx = gy;
      const th = portrait ? Math.min((H - top0 - 0.165 * H - 3 * gy) / 4, (0.95 * W) / CCTV_ASPECT) : (H - top0 - 0.165 * H - gy) / 2;
      const tw = th * (portrait ? CCTV_ASPECT : aspect);
      const px = (W - cols * tw - (cols - 1) * gx) / 2;
      const z = wall.zoom;
      const k = lerp(tw, W, z) / tw;
      const endH = portrait ? H * Math.min(1, footageBand(replay.cameraPoses[securityCameras[0].id].fov, aspect)) : H;
      const endY = (H - endH) / 2;
      /** Tile height and shape (in wall units: the canvas is scaled by k). */
      const tileH = portrait ? lerp(th, endH, z) / k : th;
      const tileAspect = portrait ? tw / tileH : aspect;
      ctx.save();
      ctx.translate(lerp(px, 0, z) - px * k, lerp(top0, endY, z) - top0 * k);
      ctx.scale(k, k);

      const clip = useAppearanceStore.getState().clips[DEMO_CLIP];
      const font = portrait ? Math.max(8, tw * 0.036) : Math.max(9, H * 0.0165);
      // Tile names, clocks and frames grow with the tile, so they leave early: before they slide under the
      // demo's own top bar and caption.
      const chrome = Math.max(0, 1 - z * 2.5);

      securityCameras.forEach((cam, i) => {
        if (i > 3) return;
        const x = px + (i % cols) * (tw + gx);
        const y = top0 + Math.floor(i / cols) * (tileH + gy);
        if (z >= 1 && i > 0) return; // CAM 01 covers the screen
        const power = tilePower(e, i);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, tw, tileH);
        ctx.clip();
        ctx.fillStyle = "#070c14";
        ctx.fillRect(x, y, tw, tileH);

        const video = videoRegistry.get(cam.id);
        const ready = !!video && video.readyState >= 2 && video.videoWidth > 0;
        const offset = replay.cameraOffsets[cam.id] ?? 0;
        if (power > 0) {
          // CRT power-on: the picture opens out of a bright centre line
          const open = power >= 1 ? tileH : Math.max(2, tileH * easeOut(power));
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, y + (tileH - open) / 2, tw, open);
          ctx.clip();
          if (ready) {
            const { sx, sy, sw, sh } = coverRect(video.videoWidth, video.videoHeight, tileAspect);
            ctx.drawImage(video, sx, sy, sw, sh, x, y, tw, tileH);

            // the subject, picked out of this feed
            const kf = clip ? Math.round((video.currentTime - offset - clip.t0) * clip.fps) : -1;
            const frame = clip?.cameras[cam.id]?.frames[kf];
            const tex = frame?.file ? peekTexture(DEMO_CLIP, frame.file) : null;
            const img = tex?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
            if (wall.highlight > 0) {
              ctx.fillStyle = `rgba(2,6,12,${0.58 * wall.highlight})`;
              ctx.fillRect(x, y, tw, tileH);
            }
            if (wall.highlight > 0 && frame?.crop && img && img.width > 0) {
              const [u0, v0, u1, v1] = frame.crop;
              const dx = x + ((u0 * video.videoWidth - sx) / sw) * tw;
              const dy = y + ((v0 * video.videoHeight - sy) / sh) * tileH;
              const dw = (((u1 - u0) * video.videoWidth) / sw) * tw;
              const dh = (((v1 - v0) * video.videoHeight) / sh) * tileH;
              ctx.save();
              ctx.globalAlpha = wall.highlight;
              ctx.shadowColor = "rgba(34,211,238,0.95)";
              ctx.shadowBlur = (10 + 14 * wall.tint) * dpr * Math.min(k, 1.6);
              ctx.drawImage(img, dx, dy, dw, dh);
              ctx.shadowBlur = 0;
              if (wall.tint > 0) {
                ctx.globalCompositeOperation = "lighter";
                ctx.globalAlpha = 0.6 * wall.tint * wall.highlight;
                ctx.drawImage(silhouette(cam.id, img), dx, dy, dw, dh);
              }
              ctx.restore();

              // lock bracket
              const pad = th * 0.03;
              const bx = dx - pad;
              const by = dy - pad;
              const bw = dw + 2 * pad;
              const bh = dh + 2 * pad;
              const arm = Math.min(bw, bh) * 0.22;
              ctx.save();
              // (the other feeds' brackets leave with their names while CAM 01 takes the screen)
              ctx.globalAlpha = wall.highlight * (i > 0 ? chrome : 1);
              ctx.strokeStyle = CYAN;
              ctx.lineWidth = (Math.max(1, H * 0.0022) * lerp(1, 1.5, z)) / k;
              ctx.beginPath();
              for (const [cx, cy, sxn, syn] of [
                [bx, by, 1, 1],
                [bx + bw, by, -1, 1],
                [bx, by + bh, 1, -1],
                [bx + bw, by + bh, -1, -1],
              ]) {
                ctx.moveTo(cx + sxn * arm, cy);
                ctx.lineTo(cx, cy);
                ctx.lineTo(cx, cy + syn * arm);
              }
              ctx.stroke();
              // the tag keeps its size on screen while the tile grows
              const tf = (font * 0.82 * lerp(1, 1.3, z)) / k;
              const tag = `${subjectLabel} \u00B7 SAM 2.1`;
              ctx.font = `600 ${tf}px ${MONO}`;
              ctx.textBaseline = "bottom";
              const tagW = ctx.measureText(tag).width + tf * 1.0;
              const tagH = tf * 1.65;
              const gap = tf * 0.35;
              // above the bracket, or under it when the subject is at the top of the tile
              const ty = by - tagH - gap < y + (font * 2.3) / k ? by + bh + gap : by - tagH - gap;
              const tx = Math.min(Math.max(bx, x + 4 / k), x + tw - tagW - 4 / k);
              ctx.fillStyle = "rgba(4,7,12,0.82)";
              ctx.fillRect(tx, ty, tagW, tagH);
              ctx.fillStyle = "#a5f3fc";
              ctx.fillText(tag, tx + tf * 0.5, ty + tagH - tf * 0.3);
              ctx.restore();
            }
          } else {
            ctx.fillStyle = "#475569";
            ctx.font = `500 ${font}px ${MONO}`;
            ctx.textBaseline = "middle";
            ctx.textAlign = "center";
            ctx.fillText("NO SIGNAL", x + tw / 2, y + tileH / 2);
            ctx.textAlign = "left";
          }
          ctx.restore();
          if (power < 1) {
            ctx.fillStyle = `rgba(200,244,255,${(1 - power) * 0.9})`;
            ctx.fillRect(x, y + (tileH - open) / 2, tw, open);
          }
        }

        // tile chrome: name, video clock, frame (gone once CAM 01 is the screen)
        if (chrome > 0.01 && power > 0.5) {
          ctx.globalAlpha = chrome * Math.min(1, (power - 0.5) * 2);
          const strip = font * 2.1;
          const grad = ctx.createLinearGradient(0, y, 0, y + strip * 1.6);
          grad.addColorStop(0, "rgba(4,7,12,0.85)");
          grad.addColorStop(1, "rgba(4,7,12,0)");
          ctx.fillStyle = grad;
          ctx.fillRect(x, y, tw, strip * 1.6);
          ctx.font = `600 ${font}px ${MONO}`;
          ctx.textBaseline = "middle";
          const blink = Math.floor(e * 1.6) % 2 === 0;
          ctx.fillStyle = blink ? "#f87171" : "rgba(248,113,113,0.35)";
          ctx.beginPath();
          ctx.arc(x + font * 1.1, y + strip / 2, font * 0.32, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#e2e8f0";
          ctx.fillText(cam.name.toUpperCase(), x + font * 1.9, y + strip / 2 + 1);
          const clock = `VID ${formatClock(Math.max(0, (video?.currentTime ?? 0)))}`;
          ctx.fillStyle = "#94a3b8";
          ctx.textAlign = "right";
          ctx.fillText(clock, x + tw - font * 0.9, y + strip / 2 + 1);
          ctx.textAlign = "left";
          ctx.globalAlpha = 1;
        }
        ctx.restore();
        if (chrome > 0.01) {
          ctx.globalAlpha = chrome;
          ctx.strokeStyle = wall.highlight > 0.5 ? "rgba(34,211,238,0.55)" : "rgba(42,59,82,0.95)";
          ctx.lineWidth = 1 / k;
          ctx.strokeRect(x + 0.5, y + 0.5, tw - 1, tileH - 1);
          ctx.globalAlpha = 1;
        }
        // portrait: the other feeds stay on screen under CAM 01's band, so they go dark as it grows
        if (portrait && i > 0 && z > 0) {
          ctx.globalAlpha = Math.min(1, z * 1.6);
          ctx.fillStyle = INK;
          ctx.fillRect(x - 1, y - 1, tw + 2, tileH + 2);
          ctx.globalAlpha = 1;
        }
      });
      ctx.restore();
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvas} className="pointer-events-none absolute inset-0 z-[40] h-full w-full" style={{ display: "none" }} />;
}
