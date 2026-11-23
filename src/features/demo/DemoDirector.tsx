import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { roomConfig } from "../../config/roomConfig";
import { subjects } from "../../config/subjects";
import { videoRegistry } from "../../lib/videoRegistry";
import { buildUniforms, buildWire, setBuildScripted } from "../../scene/buildIntro";
import { setCeilingCut } from "../../scene/ceilingClip";
import { setWindowFrames } from "../../scene/windowWallClip";
import { useReplayStore } from "../../store/useReplayStore";
import { useViewStore, type SubjectRenderMode } from "../../store/useViewStore";
import type { CameraId, CameraMode, RoomBounds, Vec3 } from "../../types/security";
import { clipsAt, frameAt, peekTexture, pinTexture, unpinAll, useAppearanceStore } from "../reconstruction/useAppearanceStore";
import { useAvatarStore } from "../reconstruction/useAvatarStore";
import { subjectSample } from "../sentry/SceneActors";
import { evidenceAt } from "../sentry/useEvidence";
import { demoLook } from "./demoLook";
import {
  buildAt,
  cameraAt,
  cctvAt,
  cctvFilterAt,
  ceilingShown,
  coverageAt,
  CAMERA_ORDER,
  DEMO_CLIP,
  DEMO_DURATION,
  DEMO_START_TIME,
  DEMO_SUBJECT,
  END_HOLD_SECONDS,
  frameWanted,
  FREEZE_TIME,
  incidentTime,
  lookStateAt,
  pathAt,
  tagLiftAt,
  videoRate,
  videosLive,
  windowFramesAt,
} from "./demoScript";
import { useDemoStore } from "./useDemoStore";

/** Viewer state the walkthrough changes, put back when it ends. */
interface Snapshot {
  time: number;
  playing: boolean;
  speed: number;
  selected: CameraId | null;
  mode: CameraMode;
  xray: boolean;
  showCoverage: boolean;
  showCeiling: boolean;
  showMarkers: boolean;
  cleanWindows: boolean;
  trackingDiagnostics: boolean;
  subjectRenderMode: SubjectRenderMode;
}

const FALLBACK_BOUNDS: RoomBounds = { min: [-2.4, 0, -6.78], max: [2.4, 3.13, 6.78], size: [4.8, 3.13, 13.56], center: [0, 1.56, 0] };
const DEG = Math.PI / 180;
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const roll = new THREE.Quaternion();
const point = new THREE.Vector3();
const subjectMeta = subjects.find((s) => s.id === DEMO_SUBJECT);

/** Demo times drawn once behind the loading card: every look, and the path, has its shaders compiled by then. */
const WARM_UP = [3.7, 6.9, 8.1, 9.2, 10.9, 12.7, 13.9, 15.9, 18.1, 19.2, 21.0, 21.7, 22.5, 22.9];

/**
 * The subject's feet at incident time t for the camera to aim at: a Gaussian average over nearby moments
 * (±SMOOTH_REACH s of incident time), so his step-to-step sway and the track's jitter do not shake the camera
 * when it follows him, above all while the replay runs several times faster than real time. Null if absent at t.
 */
const SMOOTH_REACH = 0.5;
const SMOOTH_TAPS = 9;
function smoothedSubject(t: number): Vec3 | null {
  if (!subjectSample(DEMO_SUBJECT, t)) return null;
  const acc: Vec3 = [0, 0, 0];
  let wsum = 0;
  for (let i = 0; i < SMOOTH_TAPS; i++) {
    const dt = SMOOTH_REACH * ((2 * i) / (SMOOTH_TAPS - 1) - 1);
    const st = subjectSample(DEMO_SUBJECT, t + dt);
    if (!st) continue;
    const w = Math.exp(-0.5 * (dt / (SMOOTH_REACH / 2)) ** 2);
    for (let k = 0; k < 3; k++) acc[k] += w * st.position[k];
    wsum += w;
  }
  return [acc[0] / wsum, acc[1] / wsum, acc[2] / wsum];
}

/**
 * Per CCTV camera, 0..1: the Gaussian-weighted share of moments within ±SOURCE_REACH s of incident time t at
 * which that camera's recording has his cut-out. Smooth in t, so the free camera's lingering never jumps when
 * a camera loses him.
 */
const SOURCE_REACH = 0.6;
const SOURCE_TAPS = 13;
function recordingSources(t: number): Partial<Record<CameraId, number>> {
  const out: Partial<Record<CameraId, number>> = {};
  let wsum = 0;
  for (let i = 0; i < SOURCE_TAPS; i++) {
    const dt = SOURCE_REACH * ((2 * i) / (SOURCE_TAPS - 1) - 1);
    const w = Math.exp(-0.5 * (dt / (SOURCE_REACH / 2)) ** 2);
    wsum += w;
    for (const clip of clipsAt(DEMO_SUBJECT, t + dt)) {
      for (const cam of Object.keys(clip.cameras) as CameraId[]) {
        if (frameAt(clip, cam, t + dt)?.crop) out[cam] = (out[cam] ?? 0) + w;
      }
    }
  }
  for (const cam of Object.keys(out) as CameraId[]) out[cam] = Math.min(1, (out[cam] ?? 0) / wsum);
  return out;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const frames = async (n: number) => {
  for (let i = 0; i < n; i++) await nextFrame();
};
async function until(test: () => boolean, timeoutMs: number) {
  const t0 = performance.now();
  while (!test() && performance.now() - t0 < timeoutMs) await nextFrame();
  return test();
}
/** `job` over every item, at most `limit` of them under way at a time; results in the items' order. */
async function pooled<T, R>(items: readonly T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await job(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
/** Footage frames asked for at a time while the walkthrough loads (several hundred in all). */
const FRAMES_AT_ONCE = 48;

/** The recordings sit on the frame of the shown time (or cannot play in this browser at all). */
function videosSettled(masterTime: number) {
  const offsets = useReplayStore.getState().cameraOffsets;
  for (const id of CAMERA_ORDER) {
    const v = videoRegistry.get(id);
    if (!v || v.error) continue;
    if (v.seeking || v.readyState < 2) return false;
    const target = masterTime + (offsets[id] ?? 0);
    if (target >= 0 && target <= v.duration - 0.05 && Math.abs(v.currentTime - target) > 0.045) return false;
  }
  return true;
}

function takeSnapshot(): Snapshot {
  const r = useReplayStore.getState();
  const v = useViewStore.getState();
  return {
    time: r.currentTime,
    playing: r.isPlaying,
    speed: r.playbackSpeed,
    selected: r.selectedCameraId,
    mode: r.cameraMode,
    xray: r.xrayEnabled,
    showCoverage: v.showCoverage,
    showCeiling: v.showCeiling,
    showMarkers: v.showMarkers,
    cleanWindows: v.cleanWindows,
    trackingDiagnostics: v.trackingDiagnostics,
    subjectRenderMode: v.subjectRenderMode,
  };
}

/** CSS filter on the viewport's canvas (the recordings' exposure through the pass), set only when it changes. */
function setCanvasFilter(canvas: HTMLCanvasElement, filter: string) {
  if (canvas.style.filter !== filter) canvas.style.filter = filter;
}

/**
 * Runs the demo walkthrough from inside the canvas. Every frame, before the scene's own per-frame work,
 * it sets the incident time, the camera, the room build fronts, the ceiling and the subject look from
 * demoScript for the current demo time. While the demo is idle it does nothing.
 */
export function DemoDirector() {
  const phase = useDemoStore((s) => s.phase);
  const gl = useThree((s) => s.gl);

  const snapshot = useRef<Snapshot | null>(null);
  /** Demo time shown while preparing (warm-up of the looks behind the loading card). */
  const warm = useRef(0);
  /** performance.now() at demo time 0. */
  const clock0 = useRef<number | null>(null);
  const resync = useRef(true);

  const apply = (e: number, running: boolean, camera: THREE.PerspectiveCamera, size: { width: number; height: number }) => {
    const replay = useReplayStore.getState();
    const view = useViewStore.getState();
    const manual = useDemoStore.getState().manual;
    const bounds = view.roomBounds ?? FALLBACK_BOUNDS;

    // ---- the recordings' exposure on the 3D view while it flies between cameras
    setCanvasFilter(gl.domElement, cctvFilterAt(e));

    // ---- incident time
    const T = incidentTime(e);
    const live = videosLive(e);
    if (demoLook.holdVideos === live) {
      demoLook.holdVideos = !live;
      if (live) resync.current = true;
    }
    if (live && running && !manual) {
      // The recordings are on screen: they play by themselves (faster through the pass of the cameras) and
      // the clock only steers them.
      const rate = videoRate(e);
      if (!replay.isPlaying || replay.playbackSpeed !== rate) useReplayStore.setState({ isPlaying: true, playbackSpeed: rate });
      if (resync.current || Math.abs(replay.currentTime - T) > 0.25) replay.seek(T);
      else useReplayStore.setState({ currentTime: T });
      resync.current = false;
    } else {
      if (replay.isPlaying) replay.pause();
      if (live) {
        // stepped: the recordings are seeked to the exact frame
        if (resync.current || Math.abs(replay.currentTime - T) > 1e-4) replay.seek(T);
        resync.current = false;
      } else if (replay.currentTime !== T) useReplayStore.setState({ currentTime: T });
    }

    // ---- camera
    const here = subjectSample(DEMO_SUBJECT, T);
    const aimAt = here ? smoothedSubject(T) : null;
    const frozen = subjectSample(DEMO_SUBJECT, FREEZE_TIME);
    const subject: Vec3 = frozen ? frozen.position : [-0.05, bounds.min[1], 0.42];
    const cam = cameraAt(e, { poses: replay.cameraPoses, bounds, aspect: size.width / Math.max(size.height, 1), subject, live: aimAt, sources: recordingSources(T) });
    camera.position.set(cam.p[0], cam.p[1], cam.p[2]);
    if (cam.up) camera.up.set(cam.up[0], cam.up[1], cam.up[2]);
    else camera.up.set(0, 1, 0);
    camera.lookAt(cam.t[0], cam.t[1], cam.t[2]);
    camera.up.set(0, 1, 0);
    if (cam.roll) camera.quaternion.multiply(roll.setFromAxisAngle(AXIS_Z, cam.roll * DEG));
    if (Math.abs(camera.fov - cam.fov) > 1e-4) {
      camera.fov = cam.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);

    // ---- room
    const build = buildAt(e, bounds.min[1], bounds.max[1]);
    buildUniforms.uBuildTexY.value = build.texY;
    buildUniforms.uBuildWireY.value = build.wireY;
    buildUniforms.uWireMode.value = build.wireMode;
    buildUniforms.uBuildTime.value = e;
    buildUniforms.uBuildMinY.value = build.minY;
    buildUniforms.uBuildWireGain.value = build.gain;
    buildUniforms.uBuildGridGain.value = build.grid;
    if (buildWire.object) buildWire.object.visible = build.texY < 1e5; // fully textured: no wire passes its shader
    const cutY = bounds.max[1] - roomConfig.ceilingCutOffset;
    setCeilingCut(ceilingShown(e, cutY, build.wireY), cutY);
    setWindowFrames(windowFramesAt(e));

    // ---- viewer state (only written when it changes)
    const cctv = cctvAt(e);
    if (cctv) {
      if (replay.cameraMode !== "cctv" || replay.selectedCameraId !== cctv) replay.viewThroughCamera(cctv);
    } else if (replay.cameraMode !== "orbit" || replay.selectedCameraId !== null) useReplayStore.setState({ cameraMode: "orbit", selectedCameraId: null });
    const look = lookStateAt(e);
    if (view.subjectRenderMode !== look.mode) view.setSubjectRenderMode(look.mode);
    if (replay.xrayEnabled !== look.xray) replay.setXray(look.xray);
    const coverage = coverageAt(e);
    demoLook.coverage = coverage;
    if (view.showCoverage !== coverage > 0) useViewStore.setState({ showCoverage: coverage > 0 });
    demoLook.hologram = look.hologram;
    demoLook.hideBody = look.hideBody;
    demoLook.holoStyle = look.holoStyle;
    demoLook.holoBand = bounds.min[1] + look.holoBand;
    demoLook.hideTags = look.hideTags;
    demoLook.hideTrail = look.hideTrail;
    demoLook.tagLift = tagLiftAt(e);
    const path = pathAt(e);
    demoLook.path.draw = path.draw;
    demoLook.path.alpha = path.alpha;
    demoLook.path.labels = path.labels;

    // ---- tracking bracket: the fused track's own values, projected into the viewport
    const b = demoLook.bracket;
    b.on = false;
    b.lock = look.bracket;
    if (look.bracket > 0 && here) {
      const [x, y, z] = here.position;
      const height = (subjectMeta?.heightM ?? 1.75) + 0.12;
      point.set(x, y + height, z).project(camera);
      const top = (0.5 - point.y / 2) * size.height;
      const cx = (0.5 + point.x / 2) * size.width;
      point.set(x, y - 0.04, z).project(camera);
      const bottom = (0.5 - point.y / 2) * size.height;
      if (point.z < 1 && bottom > top) {
        b.on = true;
        b.x = (cx + (0.5 + point.x / 2) * size.width) / 2;
        b.top = top;
        b.bottom = bottom;
        b.text = `${subjectMeta?.label ?? "PERSON 01"} \u00B7 X ${x.toFixed(2)} m \u00B7 Z ${z.toFixed(2)} m`;
        // the cameras that see the subject now: the same evidence that lights the markers' TRACKING labels
        const cams = [...(evidenceAt(DEMO_SUBJECT, T)?.observers ?? here.cameras)]
          .map((id) => id.replace("cam", "0"))
          .sort()
          .join(" ");
        b.sub = `${here.speed.toFixed(2)} m/s \u00B7 ${here.status.toUpperCase()}${cams ? ` \u00B7 CAM ${cams}` : ""}`;
      }
    }
    demoLook.applied = e;
  };

  // ---- lifecycle
  useEffect(() => {
    if (phase !== "preparing") return;
    let cancelled = false;
    const alive = () => !cancelled && useDemoStore.getState().phase === "preparing";
    const progress = (p: number) => alive() && useDemoStore.setState({ progress: p });

    const r = useReplayStore.getState();
    const v = useViewStore.getState();
    snapshot.current ??= takeSnapshot(); // (effects run twice under StrictMode: keep the first, untouched state)
    r.pause();
    v.setCalibrating(false);
    v.setAnnotating(false);
    v.setFocusedFeed(null);
    v.setSyncPanelOpen(false);
    useViewStore.setState({ showMarkers: true, cleanWindows: true, trackingDiagnostics: false });
    setBuildScripted(true);
    demoLook.active = true;
    demoLook.holdVideos = false;
    warm.current = 0;
    clock0.current = null;
    resync.current = true;

    (async () => {
      // 1. the room scan and the reconstruction manifests
      await until(() => !alive() || !["checking", "loading"].includes(useViewStore.getState().roomStatus), 90_000);
      progress(0.1);
      await until(() => !alive() || (!["idle", "loading"].includes(useAppearanceStore.getState().loadStatus) && !["idle", "loading"].includes(useAvatarStore.getState().loadStatus)), 15_000);
      if (!alive()) return;

      // 2. every footage frame the walkthrough draws, loaded and kept before the clock starts
      const clip = useAppearanceStore.getState().clips[DEMO_CLIP];
      const files: string[] = [];
      if (clip) for (const id of CAMERA_ORDER) for (const f of clip.cameras[id]?.frames ?? []) if (f.file && frameWanted(f.masterTime)) files.push(f.file);
      // (A stepped recording waits for every frame anyway: it waits for all of these, and skips the two warm-up steps below.)
      const stepped = useDemoStore.getState().manual;
      let done = 0;
      const textures = await Promise.race([
        pooled(files, FRAMES_AT_ONCE, async (file) => {
          if (cancelled) return null;
          const t = await pinTexture(DEMO_CLIP, file);
          done++;
          if (done % 12 === 0) progress(0.1 + 0.7 * (done / files.length));
          return t;
        }),
        new Promise<null>((res) => setTimeout(() => res(null), stepped ? 180_000 : 30_000)), // slow link: start anyway, frames arrive as they load
      ]);
      if (!alive()) return;
      progress(0.8);
      if (textures && !stepped) {
        // upload now, a few per frame, so no frame of the walkthrough waits for it
        let n = 0;
        for (const t of textures) {
          if (!t) continue;
          gl.initTexture(t);
          if (++n % 48 === 0) {
            await nextFrame();
            if (!alive()) return;
          }
        }
      }
      progress(0.88);

      // 3. draw each look once behind the loading card: shaders compile now, not mid-walkthrough
      for (const e of stepped ? [] : WARM_UP) {
        warm.current = e;
        await frames(2);
        if (!alive()) return;
      }
      warm.current = 0;
      resync.current = true;
      await frames(2);
      progress(0.96);

      // 4. the recordings on their first frame
      await until(() => !alive() || videosSettled(DEMO_START_TIME), 8_000);
      await frames(2);
      if (!alive()) return;
      resync.current = true;
      useDemoStore.setState({ phase: "running", elapsed: 0, progress: 1 });
    })();

    return () => {
      cancelled = true;
    };
  }, [phase, gl]);

  // The end card holds, then the walkthrough closes itself (not while it is being stepped).
  useEffect(() => {
    if (phase !== "ended" || useDemoStore.getState().manual) return;
    const id = window.setTimeout(() => useDemoStore.getState().stop(), END_HOLD_SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [phase]);

  // Back to idle: put the viewer back as it was.
  useEffect(() => {
    if (phase !== "idle") return;
    const snap = snapshot.current;
    if (!snap) return;
    snapshot.current = null;
    setCanvasFilter(gl.domElement, "");
    demoLook.active = false;
    demoLook.hologram = 0;
    demoLook.hideBody = false;
    demoLook.holoStyle = 0;
    demoLook.coverage = 1;
    demoLook.hideTags = false;
    demoLook.hideTrail = false;
    demoLook.tagLift = 0;
    demoLook.path.draw = 0;
    demoLook.path.alpha = 0;
    demoLook.path.labels = 0;
    demoLook.pathInfo.drawn = 0;
    for (const mark of demoLook.marks) mark.on = false;
    demoLook.holdVideos = false;
    demoLook.bracket.on = false;
    demoLook.applied = -1;
    setBuildScripted(false);
    setWindowFrames(1);
    unpinAll();
    const bounds = useViewStore.getState().roomBounds ?? FALLBACK_BOUNDS;
    setCeilingCut(snap.showCeiling || snap.mode === "cctv", bounds.max[1] - roomConfig.ceilingCutOffset);
    useViewStore.setState({
      showCoverage: snap.showCoverage,
      showCeiling: snap.showCeiling,
      showMarkers: snap.showMarkers,
      cleanWindows: snap.cleanWindows,
      trackingDiagnostics: snap.trackingDiagnostics,
      subjectRenderMode: snap.subjectRenderMode,
    });
    // One update, so each recording gets exactly one seek, straight to the time the viewer was at
    // (pausing first would seek them to the walkthrough's last time and queue this one behind it).
    useReplayStore.setState((s) => ({
      isPlaying: snap.playing,
      playbackSpeed: snap.speed,
      cameraMode: snap.mode,
      selectedCameraId: snap.selected,
      xrayEnabled: snap.xray,
      currentTime: Math.min(Math.max(snap.time, 0), s.duration),
      seekToken: s.seekToken + 1,
    }));
  }, [phase, gl]);

  useFrame((three) => {
    const s = useDemoStore.getState();
    if (s.phase === "idle" || !snapshot.current) return;
    const camera = three.camera as THREE.PerspectiveCamera;
    if (s.phase === "preparing") return apply(warm.current, false, camera, three.size);
    let e = s.elapsed;
    if (s.phase === "running" && !s.manual) {
      const now = performance.now();
      if (clock0.current === null) clock0.current = now;
      e = Math.min((now - clock0.current) / 1000, DEMO_DURATION);
      useDemoStore.setState(e >= DEMO_DURATION ? { elapsed: DEMO_DURATION, phase: "ended" } : { elapsed: e });
    }
    apply(e, s.phase === "running", camera, three.size);
  }, -1);

  // Dev / recording handle: step the walkthrough frame by frame.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handle = {
      start: (opts?: { manual?: boolean }) => useDemoStore.getState().start(opts),
      stop: () => useDemoStore.getState().stop(),
      step: (e: number) => useDemoStore.setState({ elapsed: Math.min(Math.max(e, 0), DEMO_DURATION) }),
      state: () => {
        const s = useDemoStore.getState();
        // footage frames of the walkthrough that are not loaded (a recording checks this is 0 before its first frame)
        const clip = useAppearanceStore.getState().clips[DEMO_CLIP];
        let framesMissing = 0;
        if (clip) for (const id of CAMERA_ORDER) for (const f of clip.cameras[id]?.frames ?? []) if (f.file && frameWanted(f.masterTime) && !peekTexture(DEMO_CLIP, f.file)) framesMissing++;
        return { phase: s.phase, elapsed: s.elapsed, progress: s.progress, duration: DEMO_DURATION, framesMissing };
      },
      ready: () => {
        const s = useDemoStore.getState();
        if (s.phase !== "running" && s.phase !== "ended") return false;
        if (Math.abs(demoLook.applied - s.elapsed) > 1e-6) return false;
        return demoLook.holdVideos || videosSettled(incidentTime(s.elapsed));
      },
    };
    (window as unknown as Record<string, unknown>).__sentryDemo = handle;
    return () => {
      delete (window as unknown as Record<string, unknown>).__sentryDemo;
    };
  }, []);

  return null;
}
