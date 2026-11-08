import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { XR, XRDomOverlay, XROrigin, createXRStore, useXR, useXRHitTest } from "@react-three/xr";
import * as THREE from "three";
import { Box, Compass, Eye, Footprints, Pause, Play, RotateCcw, Smartphone } from "lucide-react";
import { useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import { SceneActorsBridge, SceneLighting } from "../scene/Scene3D";
import { RoomStage } from "../scene/RoomStage";
import { WindowWall } from "../scene/WindowWall";
import { AppearanceLayer } from "../features/reconstruction/AppearanceLayer";
import { formatClock } from "../lib/format";
import { CameraFeed, MagicWindowCamera, enableMotion, viewer } from "./MagicWindow";

/**
 * Phone-only AR viewer: the reconstructed room + the real person replay, viewed through the phone.
 * - WebXR (Android Chrome): the phone IS the camera. Tap a surface to place the room as a tabletop
 *   miniature (or life-size), then walk around it to see every angle.
 * - No WebXR (iPhone Safari): touch-orbit 3D viewer with the same replay.
 * Reuses the existing scene components, replay store and master clock state; nothing else changes.
 */

const store = createXRStore({ hitTest: true, domOverlay: true, controller: false, hand: false, emulate: false, offerSession: false });

/** Tabletop = room shown at 1:SCALE (13.5 m room → ~0.9 m). */
const SCALES = { tabletop: 15, life: 1 } as const;
type ScaleMode = keyof typeof SCALES;

/** The replay window that contains the subject (from the incident events), looped. */
function useLoopWindow() {
  const events = useReplayStore((s) => s.events);
  return useMemo(() => {
    const entry = events.find((e) => e.type === "entry");
    const exit = events.find((e) => e.type === "exit");
    return { t0: Math.max(0, (entry?.time ?? 0) - 0.5), t1: (exit?.time ?? 30) + 1 };
  }, [events]);
}

/** Drives the existing master clock from the render loop (window rAF pauses during a WebXR session). */
function ARClock({ t0, t1 }: { t0: number; t1: number }) {
  useFrame((_, dt) => {
    const s = useReplayStore.getState();
    if (!s.isPlaying) return;
    const next = s.currentTime + Math.min(dt, 0.1) * s.playbackSpeed;
    if (next >= t1 || next < t0 - 1) s.seek(t0);
    else useReplayStore.setState({ currentTime: next });
  });
  return null;
}

const tmpM = new THREE.Matrix4();
const tmpP = new THREE.Vector3();

/** Hit-test reticle + tap-to-place. Places room floor-centre (0,0,0) on the tapped surface by moving/scaling the XR origin. */
function Placement({ scale, placed, onPlace }: { scale: number; placed: boolean; onPlace: () => void }) {
  const origin = useRef<THREE.Group>(null);
  const reticle = useRef<THREE.Mesh>(null);
  const hit = useRef<THREE.Vector3 | null>(null);
  const session = useXR((s) => s.session);

  useXRHitTest((results, getWorldMatrix) => {
    if (!results.length || !reticle.current) {
      hit.current = null;
      return;
    }
    getWorldMatrix(tmpM, results[0]);
    tmpP.setFromMatrixPosition(tmpM);
    hit.current = (hit.current ?? new THREE.Vector3()).copy(tmpP);
    reticle.current.position.copy(tmpP);
  }, "viewer");

  useFrame(() => {
    if (reticle.current) reticle.current.visible = !placed && hit.current != null;
    if (reticle.current) reticle.current.scale.setScalar(origin.current?.scale.x ?? 1);
  });

  useEffect(() => {
    if (!session) return;
    const onSelect = () => {
      const o = origin.current;
      if (!o || !hit.current) return;
      // World point W = O + s·h  (h = the hit in XR-local space). Want W' = (0,0,0) after re-origin at new scale s'.
      const s = o.scale.x;
      const h = hit.current.clone().sub(o.position).divideScalar(s);
      o.scale.setScalar(scale);
      o.position.copy(h.multiplyScalar(-scale));
      onPlace();
    };
    session.addEventListener("select", onSelect);
    return () => session.removeEventListener("select", onSelect);
  }, [session, scale, onPlace]);

  // Changing scale after placement keeps the placed point fixed.
  useEffect(() => {
    const o = origin.current;
    if (!o || !placed) return;
    const anchorLocal = o.position.clone().multiplyScalar(-1 / o.scale.x);
    o.scale.setScalar(scale);
    o.position.copy(anchorLocal.multiplyScalar(-scale));
  }, [scale, placed]);

  return (
    <>
      <XROrigin ref={origin} />
      <mesh ref={reticle} rotation-x={-Math.PI / 2} visible={false}>
        <ringGeometry args={[0.05, 0.065, 40]} />
        <meshBasicMaterial color="#22d3ee" toneMapped={false} />
      </mesh>
    </>
  );
}

function SceneContent({ inAR, placed, showRoom = true }: { inAR: boolean; placed: boolean; showRoom?: boolean }) {
  // In AR nothing is drawn until the room is placed (the camera feed shows instead).
  const visible = !inAR || placed;
  return (
    <group visible={visible}>
      <SceneLighting />
      <group visible={showRoom}>
        <RoomStage />
        <WindowWall />
      </group>
      {!showRoom && <gridHelper args={[14, 28, "#22d3ee", "#155e75"]} position={[0, 0.002, 0]} />}
      <SceneActorsBridge />
      <AppearanceLayer />
    </group>
  );
}

function NonXRControls({ magic }: { magic: boolean }) {
  const inAR = useXR((s) => s.mode === "immersive-ar");
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    camera.position.set(13, 15, 16);
  }, [camera]);
  if (magic) return <MagicWindowCamera />;
  return inAR ? null : <OrbitControls target={[0, 0.8, 0]} enableDamping maxPolarAngle={Math.PI * 0.49} minDistance={2} maxDistance={30} />;
}

interface MagicProps {
  magic: boolean;
  startMagic: () => void;
  exitMagic: () => void;
  showRoom: boolean;
  toggleRoom: () => void;
}
function Hud({ arSupported, inAR, placed, scaleMode, setScaleMode, onReplace, magic, startMagic, exitMagic, showRoom, toggleRoom }: {
  arSupported: boolean | null; inAR: boolean; placed: boolean; scaleMode: ScaleMode; setScaleMode: (m: ScaleMode) => void; onReplace: () => void;
} & MagicProps) {
  const t = useReplayStore((s) => s.currentTime);
  const playing = useReplayStore((s) => s.isPlaying);
  const { t0, t1 } = useLoopWindow();
  const btn = "pointer-events-auto inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border px-3 font-mono text-[12px] tracking-wide backdrop-blur";
  const off = "border-white/15 bg-black/55 text-slate-200";
  const on = "border-cyan-400/70 bg-cyan-400/20 text-cyan-100";
  return (
    <div className="pointer-events-none fixed inset-0 flex flex-col justify-between p-3" style={{ paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: "max(12px, env(safe-area-inset-bottom))" }}>
      <div className="flex items-start gap-2">
        <div className="rounded-xl border border-white/10 bg-black/55 px-3 py-2 backdrop-blur">
          <div className="font-mono text-[12px] font-semibold tracking-[0.2em] text-slate-100">
            SENTRY<span className="text-cyan-300">4D</span> <span className="text-cyan-300/80">AR</span>
          </div>
          <div className="font-mono text-[10px] text-slate-400">PERSON 01 · real footage replay</div>
          {magic && (
            <div className="mt-1 max-w-[15rem] font-mono text-[9.5px] leading-snug text-slate-300">Turn your phone to look around · drag to walk</div>
          )}
        </div>
      </div>

      {inAR && !placed && (
        <div className="mx-auto rounded-xl border border-white/10 bg-black/60 px-4 py-2 text-center font-mono text-[12px] text-slate-100 backdrop-blur">
          Move your phone to find the floor or a table,<br />then <b className="text-cyan-300">tap</b> to place the room.
        </div>
      )}

      <div className="space-y-2">
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-white/10 bg-black/55 px-3 py-2 backdrop-blur">
          <button type="button" className="text-cyan-200" onClick={() => useReplayStore.getState().togglePlay()} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </button>
          <input
            type="range"
            min={t0}
            max={t1}
            step={0.05}
            value={Math.min(Math.max(t, t0), t1)}
            onChange={(e) => useReplayStore.getState().seek(Number(e.target.value))}
            className="h-6 flex-1 accent-cyan-400"
          />
          <span className="w-16 text-right font-mono text-[11px] text-slate-200">{formatClock(t, false)}</span>
        </div>
        <div className="flex gap-2">
          {!inAR && arSupported && (
            <button type="button" className={`${btn} flex-1 border-cyan-400/70 bg-cyan-500/25 text-cyan-50`} onClick={() => void store.enterAR()}>
              <Smartphone className="h-4 w-4" /> START AR
            </button>
          )}
          {!inAR && !magic && arSupported === false && (
            <button type="button" className={`${btn} flex-1 border-cyan-400/70 bg-cyan-500/25 text-cyan-50`} onClick={startMagic}>
              <Smartphone className="h-4 w-4" /> START AR
            </button>
          )}
          {magic && (
            <>
              <button type="button" className={`${btn} ${showRoom ? on : off}`} onClick={toggleRoom}>
                <Eye className="h-4 w-4" /> {showRoom ? "ROOM" : "CAMERA"}
              </button>
              <button type="button" className={`${btn} ${off}`} onClick={() => (viewer.recenter = true)}>
                <Compass className="h-4 w-4" /> RECENTER
              </button>
              <button type="button" className={`${btn} ${off} ml-auto`} onClick={exitMagic}>
                EXIT
              </button>
            </>
          )}
          {inAR && (
            <>
              <button type="button" className={`${btn} ${scaleMode === "tabletop" ? on : off}`} onClick={() => setScaleMode("tabletop")}>
                <Box className="h-4 w-4" /> TABLE
              </button>
              <button type="button" className={`${btn} ${scaleMode === "life" ? on : off}`} onClick={() => setScaleMode("life")}>
                <Footprints className="h-4 w-4" /> LIFE-SIZE
              </button>
              {placed && (
                <button type="button" className={`${btn} ${off}`} onClick={onReplace}>
                  <RotateCcw className="h-4 w-4" /> MOVE
                </button>
              )}
              <button type="button" className={`${btn} ${off} ml-auto`} onClick={() => void store.getState().session?.end()}>
                EXIT
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ARApp() {
  const [arSupported, setArSupported] = useState<boolean | null>(null);
  const [placed, setPlaced] = useState(false);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("tabletop");
  const [inAR, setInAR] = useState(false);
  const [magic, setMagic] = useState(false);
  const [showRoom, setShowRoom] = useState(true);
  const magicProps: MagicProps = {
    magic,
    showRoom,
    toggleRoom: () => setShowRoom((v) => !v),
    startMagic: () => {
      // iOS needs both permissions requested from this tap.
      void enableMotion().then((ok) => {
        viewer.position.set(-0.3, 1.5, -1.8);
        viewer.recenter = true;
        setMagic(ok);
        useViewStore.setState({ showCeiling: true });
      });
    },
    exitMagic: () => {
      setMagic(false);
      useViewStore.setState({ showCeiling: false });
    },
  };
  const { t0, t1 } = useLoopWindow();

  useEffect(() => {
    // Dollhouse view: ceiling cut so you can look in from above; the replay auto-plays.
    useViewStore.setState({ showCeiling: false });
    const xr = (navigator as Navigator & { xr?: { isSessionSupported: (m: string) => Promise<boolean> } }).xr;
    if (!xr) setArSupported(false);
    else xr.isSessionSupported("immersive-ar").then(setArSupported, () => setArSupported(false));
    return store.subscribe((s) => {
      const active = s.mode === "immersive-ar";
      setInAR(active);
      if (!active) setPlaced(false);
    });
  }, []);

  useEffect(() => {
    const s = useReplayStore.getState();
    if (s.currentTime < t0 || s.currentTime > t1) s.seek(t0);
    if (!s.isPlaying) s.play();
  }, [t0, t1]);

  const hud = (
    <Hud arSupported={arSupported} inAR={inAR} placed={placed} scaleMode={scaleMode} setScaleMode={setScaleMode} onReplace={() => setPlaced(false)} {...magicProps} />
  );

  return (
    <div className="fixed inset-0 bg-[#05080d]" style={{ touchAction: "none" }}>
      <CameraFeed on={magic} />
      <Canvas
        style={{ position: "fixed", inset: 0 }}
        camera={{ fov: 55, near: 0.02, far: 400 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        onCreated={({ gl }) => {
          gl.localClippingEnabled = true;
          gl.outputColorSpace = THREE.SRGBColorSpace;
        }}
      >
        <XR store={store}>
          {!inAR && !magic && <color attach="background" args={["#05080d"]} />}
          <ARClock t0={t0} t1={t1} />
          <Placement scale={SCALES[scaleMode]} placed={placed} onPlace={() => setPlaced(true)} />
          <SceneContent inAR={inAR} placed={placed} showRoom={!magic || showRoom} />
          <NonXRControls magic={magic} />
          {inAR && <XRDomOverlay>{hud}</XRDomOverlay>}
        </XR>
      </Canvas>
      {!inAR && hud}
    </div>
  );
}
