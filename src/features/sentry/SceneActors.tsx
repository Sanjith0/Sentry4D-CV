/**
 * Real tracked subjects rendered in the LiDAR room (Phase 2).
 *
 * Mounted by Scene3D inside the existing <Canvas>; contract: SceneActorsProps
 * (src/types/security.ts). Positions come from Phase-1 annotations via
 * buildTrajectory() and are evaluated from the master clock every frame,
 * so play / pause / seek / speed changes are all deterministic.
 *
 * Store integration:
 *   - setActiveSubjectCount(n)  → header counter (subjects present at currentTime)
 *   - setEvents(...)            → first/last observed + tracking-gap markers
 *   - setSelectedEntity(...)    → incident panel details (live while selected)
 */
import { memo, useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { trajectoryConfig } from "../../config/subjects";
import { useReplayStore } from "../../store/useReplayStore";
import { formatClock } from "../../lib/format";
import { CAMERA_IDS, type IncidentEvent, type SceneActorsProps } from "../../types/security";
import { evidenceAt } from "./useEvidence";
import { appearanceActive } from "../reconstruction/AppearanceLayer";
import { useAppearanceStore } from "../reconstruction/useAppearanceStore";
import type { SubjectEvidence } from "./evidence";
import { Humanoid, type HumanoidHandle } from "./Humanoid";
import { useSubjectTracks, type SubjectTrack } from "./useSubjectTracks";
import type { SubjectState } from "./trajectory";

const camList = (ids: string[]) => ids.map((c) => c.replace("cam", "")).join("+");

export function evidenceSummary(ev: SubjectEvidence | null, t: number): string {
  if (!ev) return "—";
  const last = ev.lastSeen ? `last seen CAM ${ev.lastSeen.cameraId.slice(3).padStart(2, "0")} @ ${formatClock(ev.lastSeen.t)} (${(t - ev.lastSeen.t).toFixed(1)} s ago)` : "never observed";
  switch (ev.status) {
    case "observed":
      return `OBSERVED by ${ev.observers.map((c) => `CAM ${c.slice(3).padStart(2, "0")}`).join(", ")}`;
    case "estimated":
      return `ESTIMATED: no camera sees them now; ${last}`;
    case "departed":
      return `LAST SEEN: ${last}`;
    case "not-yet":
      return "Not yet observed";
    default:
      return "No observations";
  }
}

function subjectDetails(track: SubjectTrack, st: SubjectState, t: number): Record<string, string> {
  const { trajectory: tr } = track;
  const ev = evidenceAt(track.subject.id, t);
  if (!st.visible) {
    return {
      Status: t < tr.start ? `Not yet observed (first at ${formatClock(tr.start)})` : `Left view (last at ${formatClock(tr.end)})`,
      Evidence: evidenceSummary(ev, t),
      Observations: `${tr.verdicts.filter((v) => v.accepted).length} used / ${tr.verdicts.length}`,
    };
  }
  const [x, , z] = st.position;
  const deg = ((((st.rotationY * 180) / Math.PI) % 360) + 360) % 360;
  return {
    Evidence: evidenceSummary(ev, t),
    Position: `X ${x.toFixed(2)} · Z ${z.toFixed(2)} m`,
    Speed: `${st.speed.toFixed(2)} m/s`,
    Heading: `${deg.toFixed(0)}°`,
    "Path from": `${st.status === "tracked" ? "interpolated" : "ESTIMATED across gap"} · CAM ${camList(st.cameras)}`,
    "Nearest obs": `${st.nearestSampleDt.toFixed(2)} s`,
    Observations: `${tr.verdicts.filter((v) => v.accepted).length} used / ${tr.verdicts.length}`,
  };
}

const SubjectActor = memo(function SubjectActor({ track, xray }: { track: SubjectTrack; xray: boolean }) {
  const { subject, trajectory } = track;
  const root = useRef<THREE.Group>(null);
  const humanoid = useRef<HumanoidHandle>(null);
  const body = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const statusEl = useRef<HTMLDivElement>(null);
  const labelEl = useRef<HTMLDivElement>(null);
  const lastDetails = useRef("");
  const lastDetailsAt = useRef(0);
  const selected = useReplayStore((s) => s.selectedEntity?.id === subject.id);

  // Trail: preallocated line updated in place.
  const trail = useMemo(() => {
    const max = Math.max(2, Math.ceil(trajectoryConfig.trailSeconds * 15) + 2);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geom.setAttribute("color", new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    geom.setDrawRange(0, 0);
    // Vertex colors: cyan where a camera observed the person, dim amber where estimated.
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, toneMapped: false });
    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false;
    line.raycast = () => {};
    return { line, geom, max, seen: new THREE.Color(subject.color), est: new THREE.Color("#b45309") };
  }, [subject.color]);

  // Sight lines from each observing camera to the subject (provenance).
  const sight = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(CAMERA_IDS.length * 6), 3));
    geom.setDrawRange(0, 0);
    const mat = new THREE.LineDashedMaterial({ color: subject.color, dashSize: 0.18, gapSize: 0.1, transparent: true, opacity: 0.9, toneMapped: false });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    lines.raycast = () => {};
    lines.renderOrder = 999;
    return { lines, geom, mat };
  }, [subject.color]);
  useEffect(() => () => {
    sight.geom.dispose();
    sight.mat.dispose();
  }, [sight]);
  useEffect(() => () => {
    trail.geom.dispose();
    (trail.line.material as THREE.Material).dispose();
  }, [trail]);

  useFrame(({ clock }) => {
    const t = useReplayStore.getState().currentTime;
    const st = trajectory.sample(t);
    const ev = evidenceAt(subject.id, t);
    const observed = ev?.status === "observed";
    const g = root.current;
    if (!g) return;
    g.visible = st.visible;
    if (body.current) body.current.visible = !appearanceActive(subject.id);
    // drei <Html> ignores parent visibility: hide the tag explicitly when absent.
    if (labelEl.current) labelEl.current.style.display = st.visible ? "" : "none";
    if (st.visible) {
      g.position.set(st.position[0], 0, st.position[2]);
      g.rotation.y = st.rotationY;
      humanoid.current?.setPose({
        gaitPhase: st.gaitPhase,
        stride: Math.min(st.speed / 1.3, 1) * (st.speed > 0.12 ? 1 : 0),
        // Never present an unobserved position as confirmed.
        estimated: !observed,
      });
      if (statusEl.current) {
        statusEl.current.textContent = observed
          ? `OBSERVED · CAM ${camList(ev!.observers)}`
          : ev?.lastSeen
            ? `ESTIMATED · LAST SEEN CAM ${camList([ev.lastSeen.cameraId])} ${(t - ev.lastSeen.t).toFixed(1)}s ago`
            : "ESTIMATED";
        statusEl.current.style.color = observed ? "#a5f3fc" : "#fcd34d";
        // Appearance provenance: whose pixels are shown, and whether this is the recorded view.
        const ap = useAppearanceStore.getState().status[subject.id];
        if (ap?.active && ap.cameraId) {
          statusEl.current.textContent += ` · FOOTAGE CAM ${ap.cameraId.slice(3).padStart(2, "0")} · ${ap.evidence === "observed" ? "OBSERVED VIEW" : `RECONSTRUCTED VIEW ${ap.offSourceDeg}°`}`;
        }
      }
      if (labelEl.current) labelEl.current.style.borderColor = observed ? subject.color : "#f59e0b";
      if (ring.current) {
        const pulse = 1 + 0.12 * Math.sin(clock.elapsedTime * 4);
        ring.current.scale.setScalar(selected ? pulse : 1);
      }
    }

    // Trail over the last N seconds (deterministic: from the trajectory, not history).
    if (trajectoryConfig.trailSeconds > 0) {
      const pts = trajectory.path(t - trajectoryConfig.trailSeconds, t, 1 / 15);
      const arr = trail.geom.attributes.position.array as Float32Array;
      const col = trail.geom.attributes.color.array as Float32Array;
      const n = Math.min(pts.length, trail.max);
      const t0 = Math.max(t - trajectoryConfig.trailSeconds, trajectory.start); // time of pts[0]
      for (let i = 0; i < n; i++) {
        const k = pts.length - n + i;
        arr.set(pts[k], i * 3);
        const c = evidenceAt(subject.id, Math.min(t0 + k / 15, t))?.status === "observed" ? trail.seen : trail.est;
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
      }
      trail.geom.attributes.position.needsUpdate = true;
      trail.geom.attributes.color.needsUpdate = true;
      trail.geom.setDrawRange(0, st.visible ? n : 0);
    }

    // Sight lines: observing camera → subject chest. Drawn through walls only in X-ray.
    {
      const arr = sight.geom.attributes.position.array as Float32Array;
      let k = 0;
      if (st.visible && observed) {
        const poses = useReplayStore.getState().cameraPoses;
        for (const c of ev!.observers) {
          arr.set(poses[c].position, k * 6);
          arr.set([st.position[0], subject.heightM * 0.6, st.position[2]], k * 6 + 3);
          k++;
        }
      }
      sight.geom.setDrawRange(0, k * 2);
      sight.geom.attributes.position.needsUpdate = true;
      if (k) sight.lines.computeLineDistances();
      sight.mat.depthTest = !xray;
    }

    // Live selection details (~4 Hz, only when changed).
    if (selected && clock.elapsedTime - lastDetailsAt.current > 0.25) {
      lastDetailsAt.current = clock.elapsedTime;
      const details = subjectDetails(track, st, t);
      const key = JSON.stringify(details);
      if (key !== lastDetails.current) {
        lastDetails.current = key;
        useReplayStore.getState().setSelectedEntity({ id: subject.id, label: subject.label, kind: "person", details });
      }
    }
  });

  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    lastDetails.current = "";
    const t = useReplayStore.getState().currentTime;
    useReplayStore
      .getState()
      .setSelectedEntity({ id: subject.id, label: subject.label, kind: "person", details: subjectDetails(track, trajectory.sample(t), t) });
  };

  return (
    <>
      <primitive object={trail.line} />
      <primitive object={sight.lines} />
      <group ref={root} name={subject.id} visible={false}>
        <group
          onClick={select}
          onPointerOver={() => (document.body.style.cursor = "pointer")}
          onPointerOut={() => (document.body.style.cursor = "")}
        >
          {/* Debug avatar body; hidden while the REAL APPEARANCE renderer draws this subject. */}
          <group ref={body}>
            <Humanoid ref={humanoid} heightM={subject.heightM} build={subject.build} color={subject.color} highlighted={selected} xray={xray} />
          </group>
          {/* generous invisible hit volume */}
          <mesh position={[0, subject.heightM / 2, 0]}>
            <cylinderGeometry args={[0.32, 0.32, subject.heightM, 10]} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} />
          </mesh>
        </group>
        <mesh ref={ring} position={[0, 0.01, 0]} rotation-x={-Math.PI / 2} raycast={() => null}>
          <ringGeometry args={[0.36, selected ? 0.46 : 0.41, 40]} />
          <meshBasicMaterial color={subject.color} transparent opacity={selected ? 0.9 : 0.5} toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
        <Html position={[0, subject.heightM + 0.32, 0]} center zIndexRange={[22, 0]} style={{ pointerEvents: "none" }}>
          <div
            ref={labelEl}
            className="rounded border bg-ink-950/85 px-1.5 py-0.5 text-center font-mono text-[10px] leading-tight whitespace-nowrap backdrop-blur"
            style={{ borderColor: subject.color }}
          >
            <div className="font-semibold tracking-wider text-slate-100">{subject.label}</div>
            <div ref={statusEl} className="text-[9px]" />
          </div>
        </Html>
      </group>
    </>
  );
});

/** Keeps the shared store in sync: active count, events, default selection. */
function useStoreSync(tracks: SubjectTrack[]) {
  // Entry / exit / gap events, derived only from real annotations.
  useEffect(() => {
    const events: IncidentEvent[] = [];
    for (const { subject, trajectory: tr } of tracks) {
      const first = tr.samples[0];
      const last = tr.samples[tr.samples.length - 1];
      events.push({
        id: `${subject.id}-entry`,
        time: tr.start,
        type: "entry",
        entityId: subject.id,
        description: `${subject.label} first observed (CAM ${camList(first.cameras)})`,
      });
      tr.gaps.forEach(([a, b], i) =>
        events.push({
          id: `${subject.id}-gap-${i}`,
          time: a,
          type: "gap",
          entityId: subject.id,
          description: `${subject.label} not observed for ${(b - a).toFixed(1)} s, position estimated until ${formatClock(b)}`,
        }),
      );
      if (tr.samples.length > 1)
        events.push({
          id: `${subject.id}-exit`,
          time: tr.end,
          type: "exit",
          entityId: subject.id,
          description: `${subject.label} last observed (CAM ${camList(last.cameras)})`,
        });
    }
    const s = useReplayStore.getState();
    if (JSON.stringify(s.events) !== JSON.stringify([...events].sort((a, b) => a.time - b.time))) s.setEvents(events);
    // Select the first subject by default so its live details show in the incident panel.
    if (!s.selectedEntity && tracks[0]) {
      const t = s.currentTime;
      s.setSelectedEntity({
        id: tracks[0].subject.id,
        label: tracks[0].subject.label,
        kind: "person",
        details: subjectDetails(tracks[0], tracks[0].trajectory.sample(t), t),
      });
    }
  }, [tracks]);

  // Active subject count follows the master clock.
  useFrame(() => {
    const s = useReplayStore.getState();
    const n = tracks.reduce((a, tr) => a + (tr.trajectory.sample(s.currentTime).visible ? 1 : 0), 0);
    if (n !== s.activeSubjectCount) s.setActiveSubjectCount(n);
  });
}

/** Latest trajectories by subject id (for DOM-side helpers such as LOCATE). */
const liveTracks = new Map<string, SubjectTrack>();
/** Full trajectory sample (position + tracked/estimated status), or null when absent. */
export function subjectSample(subjectId: string, t: number) {
  const st = liveTracks.get(subjectId)?.trajectory.sample(t);
  return st?.visible ? st : null;
}
export function subjectPosition(subjectId: string, t: number) {
  const st = liveTracks.get(subjectId)?.trajectory.sample(t);
  return st?.visible ? st.position : null;
}

export function SceneActors({ xrayEnabled }: SceneActorsProps) {
  const tracks = useSubjectTracks();
  liveTracks.clear();
  for (const tr of tracks) liveTracks.set(tr.subject.id, tr);
  useStoreSync(tracks);
  return (
    <group name="SceneActors">
      {tracks.map((tr) => (
        <SubjectActor key={tr.subject.id} track={tr} xray={xrayEnabled} />
      ))}
    </group>
  );
}

export default SceneActors;
