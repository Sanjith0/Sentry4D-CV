# Sentry3D (Sentry4D-CV)

Interactive 3D security investigation console: a LiDAR-scanned room, a video-game-style free camera, four virtual CCTV cameras, and one master replay timeline that drives the recordings and the 3D scene together.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
```

## Assets

| Path | What | If missing |
|---|---|---|
| `public/assets/room.glb` | Polycam LiDAR scan (textured, meters, Y-up) | Procedural placeholder room |
| `public/videos/cam1..4.mp4` | Real CCTV recordings | Feed shows **NO RECORDING** (never substituted) |

### Getting a sharper scan

The app applies max anisotropic filtering, sharpening, ambient occlusion and grading. Tune these in `roomConfig.rendering`, or use the PERF / BAL / ULTRA toggle in the toolbar. The **blobby geometry**, though, comes from the export and can only be fixed at the source. In Polycam, re-export the GLB at the **highest mesh detail** (Full/raw, not Optimized) and the largest texture size, then replace `public/assets/room.glb`. No code changes are needed. The console logs the interior size; it should still read ≈ 4.80 × 3.13 × 13.55 m. If the new export uses a different origin, update `roomConfig.interior` and the camera poses. Files over 100 MB can't be pushed to GitHub: share them separately, or compress with `npx @gltf-transform/cli meshopt in.glb out.glb` (drei loads meshopt automatically).

Use H.264 MP4s with a keyframe every ~1 s (`-g 30`) and `-movflags +faststart` for smooth scrubbing.

## Configuration (all in `src/config/`)

- **`roomConfig.ts`**: GLB transform (scale/rotation/offset), `interior` = the real room box in scan coordinates (the scan also contains stuff seen through the window wall; grounding, framing and the ceiling cut use this box, so the floor is y=0 and the room center is the origin), material mode (`unlit` shows the scan as captured; `standard` = lit PBR), lighting, ceiling cut height, supplemental floor/wall patches for scan holes, placeholder dimensions. The GLB file is never modified; materials are cloned in memory.
- **`cameras.ts`**: the four `SecurityCamera`s (position, target, fov, videoUrl, timeOffset). Poses are estimates in the four interior corners (2.7 m high, aimed at the room center). To fine-tune one: free camera → fly to the camera spot → aim → click **POSE** in the toolbar → paste the JSON. The JSON is also logged to the console.
  - `timeOffset` = master-timeline second at which that video's frame 0 happens (`videoTime = masterTime - timeOffset`).
- **`incident.ts`**: incident name, recording start time (wall-clock display), event type → color mapping.

## Controls

| | |
|---|---|
| Free cam | click scene = mouse look (pointer lock), **WASD** move, **Space/E** up, **Shift/Q** down, **Ctrl** sprint, wheel = speed, **Esc** release |
| Modes | **F** free · **O** orbit · **T** top-down · **1–4** view through CCTV camera · **R** reset view |
| Replay | **K** (or Space outside free cam) play/pause · **←/→** ±5 s (Shift ±1 s) |
| Toggles | **X** X-ray · **M** Sentry Mode · **C** coverage frustums · **H** ceiling |

Click a camera marker in the 3D view to look through it. Click a feed to link it to its marker, double-click (or ⤢) to enlarge it, and use 👁 to view through that camera.

## Architecture

```
src/
  app/App.tsx                  layout + keyboard shortcuts
  store/useReplayStore.ts      master replay state (time, playback, camera mode, toggles, events)
  store/useViewStore.ts        viewer UI state (room bounds/status, coverage, ceiling, fly speed)
  hooks/useMasterClock.ts      the single rAF clock; nothing else advances time
  scene/                       Scene3D, RoomStage/RoomModel/ProceduralRoom, CameraControls (rig),
                               FreeFlyControls, CameraMarkers, SupplementalGeometry
  dashboard/                   Header, ViewerToolbar/HUD, CCTVPanel/CCTVFeed, ReplayTimeline, IncidentPanel
  types/security.ts            shared contracts
  features/sentry/             owned by Jason
```

**Replay sync.** `currentTime` is advanced only by `useMasterClock`. Each `<video>` follows it. Explicit seeks (`seekToken`) hard-seek the video. During playback, drift over 60 ms is corrected by nudging `playbackRate` ±8%, and drift over 350 ms is hard-seeked. This avoids constantly writing `video.currentTime`.

**Camera rig.** `CameraControls` is the only thing that moves the camera between modes. It animates to the target pose and only then mounts that mode's controller (OrbitControls / FreeFlyControls), so controllers never fight.

## Integration contract for the sentry feature (Jason)

`src/features/sentry/SceneActors.tsx` is a stub; replace it. It is rendered inside the `<Canvas>` (wrapped in an ErrorBoundary + Suspense) with:

```ts
interface SceneActorsProps {          // src/types/security.ts
  currentTime: number;                // master time, seconds
  xrayEnabled: boolean;
  sentryEnabled: boolean;
  roomBounds: RoomBounds | null;      // world-space, floor at y=0
  cameras: SecurityCamera[];
}
```

- Derive **all** state from `currentTime` (deterministic seeking). For per-frame reads without re-rendering, use `useReplayStore.getState().currentTime` inside `useFrame`.
- Push data into the shell through the store:
  - `useReplayStore.getState().setEvents(events)`: timeline markers, incident log, jump-to-event
  - `setActiveSubjectCount(n)`: header counter
  - `setSelectedEntity({ id, label, kind, details })`: incident panel "Selection"
- Coordinates: meters, Y-up, room floor at y = 0, same space as `config/cameras.ts`.
- Dev console: `window.__sentry.replay.getState()` / `.view` / `.viewport.camera`.
