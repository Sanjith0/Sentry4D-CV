import { useEffect, useRef } from "react";
import { securityCameras } from "../../config/cameras";
import { subjects } from "../../config/subjects";
import { formatClock } from "../../lib/format";
import { videoRegistry } from "../../lib/videoRegistry";
import { useReplayStore } from "../../store/useReplayStore";
import type { CameraId, SecurityCamera } from "../../types/security";
import type { AppearanceClipManifest } from "../reconstruction/ReconstructionTypes";
import { peekTexture, useAppearanceStore } from "../reconstruction/useAppearanceStore";
import { CCTV_ASPECT } from "../../config/cctv";
import { clamp01, DEMO_CLIP, DEMO_SUBJECT, footageBand, lerp, wallAt } from "./demoScript";
import { useDemoStore } from "./useDemoStore";

const INK = "#04070c";
const CYAN = "#22d3ee";
const MONO = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace';
const subjectLabel = subjects.find((s) => s.id === DEMO_SUBJECT)?.label ?? "PERSON 01";

/** Punch-in: the subject is brought to this share of the picture's height, by at most MAX_PUNCH. */
const SUBJECT_FILL = 0.5;
const MAX_PUNCH = 1.9;
/** ...and towards this point of the picture (clear of the top bar and of the caption). */
const AIM = [0.5, 0.46];
/** Whip between two cameras: the picture is smeared sideways by up to this factor. */
const SMEAR = 70;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How one recording is drawn into its rectangle. */
interface FeedStyle {
  /** 0..1: the subject's cut-out lit. */
  highlight: number;
  /** 0..1: the picture dimmed around the cut-out. */
  dim: number;
  /** 0..1: X-ray tint on the cut-out. */
  tint: number;
  /** 0..1: lock bracket and tag. */
  mark: number;
  /** Closer in on the subject (0 = the whole picture), framed on the cut-out of this incident time. */
  punch: number;
  focusTime: number;
  /** 0..1: the tile's own name, clock and frame. */
  chrome: number;
  /** Font sizes (px): tile name, subject tag. */
  font: number;
  tagFont: number;
  /** Bracket line width (px) and glow scale. */
  line: number;
  glow: number;
  /** Bracket and tag stay between these heights (px): clear of the demo's top bar and caption. */
  safeTop: number;
  safeBottom: number;
}

interface Env {
  clip: AppearanceClipManifest | undefined;
  offsets: Record<CameraId, number>;
  dpr: number;
  /** Demo clock (blinking REC dots). */
  e: number;
}

/** Source rectangle of a w x h picture that fills a tile of the given aspect edge to edge (cover fit). */
function coverRect(w: number, h: number, aspect: number) {
  if (aspect > w / h) {
    const sh = w / aspect;
    return { sx: 0, sy: (h - sh) / 2, sw: w, sh };
  }
  const sw = h * aspect;
  return { sx: (w - sw) / 2, sy: 0, sw, sh: h };
}

/** The subject's box in a camera's picture at (or next to) an incident time. */
function cropNear(clip: AppearanceClipManifest | undefined, cam: CameraId, masterTime: number) {
  const frames = clip?.cameras[cam]?.frames;
  if (!clip || !frames) return null;
  const k0 = Math.round((masterTime - clip.t0) * clip.fps);
  for (let d = 0; d <= 30; d++) {
    const crop = frames[k0 + d]?.crop ?? frames[k0 - d]?.crop;
    if (crop) return crop;
  }
  return null;
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

/** One recording into rectangle r: the picture, the subject picked out of it, the tile's own labels. */
function drawFeed(ctx: CanvasRenderingContext2D, env: Env, cam: SecurityCamera, r: Rect, st: FeedStyle) {
  const video = videoRegistry.get(cam.id);
  const ready = !!video && video.readyState >= 2 && video.videoWidth > 0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.fillStyle = "#070c14";
  ctx.fillRect(r.x, r.y, r.w, r.h);

  if (ready) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    let { sx, sy, sw, sh } = coverRect(vw, vh, r.w / r.h);
    if (st.punch > 0) {
      // Closer in on the subject: a zoom about a fixed point of the picture, chosen so that the subject ends
      // up near AIM. (A point inside the picture: it keeps filling its rectangle all the way in.)
      const box = cropNear(env.clip, cam.id, st.focusTime);
      let qx = 0.5;
      let qy = 0.5;
      let full = 1.25;
      if (box) {
        const cx = (((box[0] + box[2]) / 2) * vw - sx) / sw;
        const cy = (((box[1] + box[3]) / 2) * vh - sy) / sh;
        full = Math.min(Math.max(SUBJECT_FILL / (((box[3] - box[1]) * vh) / sh), 1.25), MAX_PUNCH);
        qx = clamp01((cx * full - AIM[0]) / (full - 1));
        qy = clamp01((cy * full - AIM[1]) / (full - 1));
      }
      const zoom = Math.pow(full, st.punch);
      sx += sw * qx * (1 - 1 / zoom);
      sy += sh * qy * (1 - 1 / zoom);
      sw /= zoom;
      sh /= zoom;
    }
    ctx.drawImage(video, sx, sy, sw, sh, r.x, r.y, r.w, r.h);

    // the subject, picked out of this feed
    const clip = env.clip;
    const kf = clip ? Math.round((video.currentTime - (env.offsets[cam.id] ?? 0) - clip.t0) * clip.fps) : -1;
    const frame = clip?.cameras[cam.id]?.frames[kf];
    const tex = frame?.file ? peekTexture(DEMO_CLIP, frame.file) : null;
    const img = tex?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (st.dim > 0) {
      ctx.fillStyle = `rgba(2,6,12,${0.58 * st.dim})`;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    if (st.highlight > 0 && frame?.crop && img && img.width > 0) {
      const [u0, v0, u1, v1] = frame.crop;
      const dx = r.x + ((u0 * vw - sx) / sw) * r.w;
      const dy = r.y + ((v0 * vh - sy) / sh) * r.h;
      const dw = (((u1 - u0) * vw) / sw) * r.w;
      const dh = (((v1 - v0) * vh) / sh) * r.h;
      ctx.save();
      ctx.globalAlpha = st.highlight;
      ctx.shadowColor = "rgba(34,211,238,0.95)";
      ctx.shadowBlur = (10 + 14 * st.tint) * env.dpr * st.glow;
      ctx.drawImage(img, dx, dy, dw, dh);
      ctx.shadowBlur = 0;
      if (st.tint > 0) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.6 * st.tint * st.highlight;
        ctx.drawImage(silhouette(cam.id, img), dx, dy, dw, dh);
      }
      ctx.restore();

      // lock bracket: around the cut-out, as much of it as lies in the free part of the picture
      const pad = r.h * 0.03;
      const x0 = Math.max(dx - pad, r.x + 2);
      const x1 = Math.min(dx + dw + pad, r.x + r.w - 2);
      const y0 = Math.max(dy - pad, st.safeTop);
      const y1 = Math.min(dy + dh + pad, st.safeBottom);
      if (st.mark > 0.01 && x1 - x0 > 8 && y1 - y0 > 8) {
        const arm = Math.min(x1 - x0, y1 - y0) * 0.22;
        ctx.save();
        ctx.globalAlpha = st.highlight * st.mark;
        ctx.strokeStyle = CYAN;
        ctx.lineWidth = st.line;
        ctx.beginPath();
        for (const [cx, cy, sxn, syn] of [
          [x0, y0, 1, 1],
          [x1, y0, -1, 1],
          [x0, y1, 1, -1],
          [x1, y1, -1, -1],
        ]) {
          ctx.moveTo(cx + sxn * arm, cy);
          ctx.lineTo(cx, cy);
          ctx.lineTo(cx, cy + syn * arm);
        }
        ctx.stroke();
        const tf = st.tagFont;
        const tag = `${subjectLabel} \u00B7 SAM 2.1`;
        ctx.font = `600 ${tf}px ${MONO}`;
        ctx.textBaseline = "bottom";
        const tagW = ctx.measureText(tag).width + tf * 1.0;
        const tagH = tf * 1.65;
        const gap = tf * 0.35;
        // above the bracket; under it when the subject is at the top of the picture; else inside its top edge
        const roof = Math.max(st.safeTop, r.y + st.font * 2.3 * st.chrome);
        let ty = y0 - tagH - gap;
        if (ty < roof) ty = y1 + gap;
        if (ty + tagH > st.safeBottom) ty = y0 + gap;
        const tx = Math.min(Math.max(x0, r.x + 4), r.x + r.w - tagW - 4);
        ctx.fillStyle = "rgba(4,7,12,0.82)";
        ctx.fillRect(tx, ty, tagW, tagH);
        ctx.fillStyle = "#a5f3fc";
        ctx.fillText(tag, tx + tf * 0.5, ty + tagH - tf * 0.3);
        ctx.restore();
      }
    }
  } else {
    ctx.fillStyle = "#475569";
    ctx.font = `500 ${st.font}px ${MONO}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillText("NO SIGNAL", r.x + r.w / 2, r.y + r.h / 2);
    ctx.textAlign = "left";
  }

  // the tile's own labels: name, video clock, frame (gone once a camera is the whole screen)
  if (st.chrome > 0.01) {
    const font = st.font;
    ctx.globalAlpha = st.chrome;
    const strip = font * 2.1;
    const grad = ctx.createLinearGradient(0, r.y, 0, r.y + strip * 1.6);
    grad.addColorStop(0, "rgba(4,7,12,0.85)");
    grad.addColorStop(1, "rgba(4,7,12,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(r.x, r.y, r.w, strip * 1.6);
    ctx.font = `600 ${font}px ${MONO}`;
    ctx.textBaseline = "middle";
    const blink = Math.floor(env.e * 1.6) % 2 === 0;
    ctx.fillStyle = blink ? "#f87171" : "rgba(248,113,113,0.35)";
    ctx.beginPath();
    ctx.arc(r.x + font * 1.1, r.y + strip / 2, font * 0.32, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText(cam.name.toUpperCase(), r.x + font * 1.9, r.y + strip / 2 + 1);
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = "right";
    ctx.fillText(`VID ${formatClock(Math.max(0, video?.currentTime ?? 0))}`, r.x + r.w - font * 0.9, r.y + strip / 2 + 1);
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  if (st.chrome > 0.01) {
    ctx.globalAlpha = st.chrome;
    ctx.strokeStyle = st.highlight > 0.5 ? "rgba(34,211,238,0.55)" : "rgba(42,59,82,0.95)";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.globalAlpha = 1;
  }
}

/** Sideways smear of everything drawn so far (the whip between two cameras); amount 0..1. */
let narrow: HTMLCanvasElement | null = null;
function smear(ctx: CanvasRenderingContext2D, el: HTMLCanvasElement, amount: number) {
  narrow ??= document.createElement("canvas");
  // squeezed to a few columns and stretched back: every row keeps its height and loses its detail along the pan
  const w = Math.max(6, Math.round(el.width / (1 + amount * SMEAR)));
  if (narrow.width !== w || narrow.height !== el.height) {
    narrow.width = w;
    narrow.height = el.height;
  }
  const g = narrow.getContext("2d")!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.globalCompositeOperation = "copy";
  g.drawImage(el, 0, 0, el.width, el.height, 0, 0, w, el.height);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(narrow, 0, 0, w, el.height, 0, 0, el.width, el.height);
  ctx.restore();
}

/**
 * The opening of the demo walkthrough, drawn from the same <video> elements the feed panel plays: the four
 * recordings as a CCTV wall with the subject's SAM 2.1 cut-out lit in each, a push into CAM 01 until it
 * fills the screen, a quick pass through the other three cameras and back (each closer in on the subject),
 * and the fade ("real footage" 100% → 0%) onto the 3D viewport underneath, which shows the same view.
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
      const gap = 0.02 * H;
      const th = portrait ? Math.min((H - top0 - 0.165 * H - 3 * gap) / 4, (0.95 * W) / CCTV_ASPECT) : (H - top0 - 0.165 * H - gap) / 2;
      const tw = th * (portrait ? CCTV_ASPECT : aspect);
      const left = (W - cols * tw - (cols - 1) * gap) / 2;
      const z = wall.zoom;
      // everything grows by k about tile 1, which ends as the screen (portrait: as the band)
      const k = lerp(tw, W, z) / tw;
      const endH = portrait ? H * Math.min(1, footageBand(replay.cameraPoses[securityCameras[0].id].fov, aspect)) : H;
      const endY = (H - endH) / 2;
      const tileH = portrait ? lerp(th, endH, z) : th * k;
      const x0 = lerp(left, 0, z);
      const y0 = lerp(top0, endY, z);

      const env: Env = { clip: useAppearanceStore.getState().clips[DEMO_CLIP], offsets: replay.cameraOffsets, dpr, e };
      const font = portrait ? Math.max(8, tw * 0.036) : Math.max(9, H * 0.0165);
      const style = (r: Rect, mark: number, chrome: number, punch: number, focusTime: number): FeedStyle => ({
        highlight: wall.highlight,
        dim: wall.dim,
        tint: wall.tint,
        mark,
        punch,
        focusTime,
        chrome,
        font: font * k,
        // the tag keeps its size on screen while the tile grows
        tagFont: font * 0.82 * lerp(1, 1.3, z),
        line: Math.max(1, H * 0.0022) * lerp(1, 1.5, z),
        glow: Math.min(k, 1.6),
        safeTop: Math.max(r.y + 2, z * 0.085 * H),
        safeBottom: Math.min(r.y + r.h - 2, H - z * 0.165 * H),
      });

      if (z < 1) {
        // Tile names, clocks and frames grow with the tile, so they leave early: before they slide under the
        // demo's own top bar and caption.
        const chrome = Math.max(0, 1 - z * 2.5);
        const first = wall.views[0];
        securityCameras.slice(0, 4).forEach((cam, i) => {
          const r: Rect = { x: x0 + (i % cols) * (tw + gap) * k, y: y0 + Math.floor(i / cols) * (tileH + gap * k), w: tw * k, h: tileH };
          if (r.x >= W || r.y >= H) return;
          // (the other feeds' brackets leave with their names while CAM 01 takes the screen)
          drawFeed(ctx, env, cam, r, style(r, i > 0 ? chrome : 1, chrome, i === 0 ? first.punch : 0, first.focusTime));
          // portrait: the other feeds stay on screen under CAM 01's band, so they go dark as it grows
          if (portrait && i > 0 && z > 0) {
            ctx.globalAlpha = Math.min(1, z * 1.6);
            ctx.fillStyle = INK;
            ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
            ctx.globalAlpha = 1;
          }
        });
        return;
      }

      // One camera is the screen; during a whip the next one slides in beside it.
      for (const view of wall.views) {
        const cam = securityCameras.find((c) => c.id === view.cam);
        if (!cam) continue;
        const r: Rect = { x: view.x * W, y: endY, w: W, h: endH };
        drawFeed(ctx, env, cam, r, style(r, 1, 0, view.punch, view.focusTime));
      }
      if (wall.streak > 0.01) {
        smear(ctx, el, wall.streak);
        // the edge between the two pictures, as a streak of light
        const edge = wall.views[1] ? wall.views[1].x * W + (wall.views[1].x > 0 ? 0 : W) : 0;
        const half = 0.05 * W;
        const light = ctx.createLinearGradient(edge - half, 0, edge + half, 0);
        light.addColorStop(0, "rgba(165,243,252,0)");
        light.addColorStop(0.5, `rgba(207,250,254,${0.5 * wall.streak})`);
        light.addColorStop(1, "rgba(165,243,252,0)");
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = light;
        ctx.fillRect(edge - half, endY, 2 * half, endH);
        ctx.globalCompositeOperation = "source-over";
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvas} className="pointer-events-none absolute inset-0 z-[40] h-full w-full" style={{ display: "none" }} />;
}
