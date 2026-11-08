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
| `public/videos/Jason_cam_01.mov`, `Jason_Cam_02.MOV`, `Jason_cam_03.mov`, `Jason_Cam_04.mov` | Real CCTV recordings (paths in `config/cameras.ts`; **case-sensitive** on Linux hosts) | Feed shows FILE NOT FOUND / CODEC NOT SUPPORTED (never substituted) |

### Getting a sharper scan

The app applies max anisotropic filtering, sharpening, ambient occlusion and grading. Tune these in `roomConfig.rendering`, or use the PERF / BAL / ULTRA toggle in the toolbar. The **blobby geometry**, though, comes from the export and can only be fixed at the source. In Polycam, re-export the GLB at the **highest mesh detail** (Full/raw, not Optimized) and the largest texture size, then replace `public/assets/room.glb`. No code changes are needed. The console logs the interior size; it should still read ≈ 4.80 × 3.13 × 13.55 m. If the new export uses a different origin, update `roomConfig.interior` and the camera poses. Files over 100 MB can't be pushed to GitHub: share them separately, or compress with `npx @gltf-transform/cli meshopt in.glb out.glb` (drei loads meshopt automatically).

Three of the recordings are iPhone HEVC (Main 10, HDR). They play in Chrome or Safari on macOS but **not in Firefox**; the feed shows "CODEC NOT SUPPORTED" there. For other browsers, transcode to H.264 MP4s with a keyframe every ~1 s (`-g 30`) and `-movflags +faststart` for smooth scrubbing.

## Configuration (all in `src/config/`)

- **`roomConfig.ts`**: GLB transform (scale/rotation/offset), `interior` = the real room box in scan coordinates (the scan also contains stuff seen through the window wall; grounding, framing and the ceiling cut use this box, so the floor is y=0 and the room center is the origin), material mode (`unlit` shows the scan as captured; `standard` = lit PBR), lighting, ceiling cut height, supplemental floor/wall patches for scan holes, placeholder dimensions. The GLB file is never modified; materials are cloned in memory.
- **`cameras.ts`**: names and video files of the four cameras.
- **`camera-poses.json`**: each virtual camera's calibrated pose: `position` (m), `yaw`/`pitch`/`roll` (degrees; yaw 0 = looking toward −Z, + = turn left; + pitch = look up), `fov` (vertical FOV of the 16:9 frame). **Edit it from the app** (see Calibrating cameras below), not by hand.
  - `offset`: sync offset, **`videoTime = masterTime + offset`**. Defaults come from `src/config/camera-sync.json`.

## Calibrating cameras (in the app)

1. Select a camera (marker click, **1–4**, or the CCTV feed's 👁), then click **CALIBRATE CAMERA**.
2. The real recording is overlaid on the virtual view inside the 16:9 frame. Set the overlay **opacity**, or use **DIFFERENCE** blend: matching areas go dark, so align until the image is darkest.
3. Adjust until the room lines up with the footage:
   - **Drag** in the view to aim (the image follows the cursor), **wheel** = FOV.
   - **W/A/S/D** move, **Q/E** down/up, **←/→** pan, **↑/↓** tilt, **[ / ]** FOV, **, / .** roll. Hold **Shift** for fine steps (1 cm / 0.1°).
   - Or use the sliders and number fields (X/Y/Z, pan/tilt/roll, FOV).
   - Tip: scrub to a frame with no people in it, then match fixed features (wall edges, the TV, booths). Get FOV and position roughly right first, then refine aim.
4. **SAVE TO PROJECT** writes all four poses to `src/config/camera-poses.json`, without reloading the page. Commit that file to share the calibration. **REVERT CAM** undoes unsaved edits; a • marks cameras with unsaved changes.

Saving goes through a small dev-server endpoint (`vite.config.ts`, `sentry3dConfigWriter`), so it only works under `npm run dev`. It accepts only the two whitelisted, validated JSON files. In a production build, use **COPY JSON** instead.

## Annotating real subjects (video → 3D floor)

**ANNOTATE SUBJECT** (header) pauses playback, opens the annotation panel beside the 3D view, and switches the 3D view to TOP.
1. Pick a camera tab (or press **1–4**), step to a frame (**←/→** = ±1 frame, **Shift** = ±0.5 s, or the buttons), and click the person's **feet**.
2. The point is projected onto the floor (y = 0) with the calibrated camera and appears in the 3D room as a cyan pillar, with a sight ray from the camera and a label (camera, master/video time, X/Y/Z, confidence).
3. Verification:
   - In the frame, the **cyan dot** is your click and the **dashed ring** is the 3D point projected back into that camera.
   - An **amber ◆** shows another camera's annotation at the same time, projected into this view. If calibration and sync are right, it sits on the same person's feet.
   - The confidence comes from the expected floor error for a 6 px click error. You get warnings near walls and at grazing angles, and when the ray hits scanned furniture or walls before reaching the floor.
4. Correct: click ✎ on a row, then re-click in the video, or click the floor in the TOP view (`source: "manual-topdown"`). Delete with 🗑. **Undo** with the button or **Cmd/Ctrl+Z**.
5. Annotations auto-save in this browser. **EXPORT JSON** downloads the active person (`{personId, observations:[{masterTime, cameraId, pixel, worldPosition, source}]}`). **IMPORT** accepts that format or `{datasets:[…]}`. **SAVE TO PROJECT** writes all persons to `src/data/person-annotations.json` (dev server); commit it. That file also seeds a browser that has no saved annotations. **RE-PROJECT** recomputes positions from the clicked pixels after a calibration change.

Times are **master time** (`masterTime = videoTime − offset`). Pixels are normalized `[u, v]` in the upright displayed frame (0,0 = top-left). The math lives in `src/lib/videoProjection.ts` (`videoPixelToWorld`, `worldToVideoPixel`).

## Tracked subjects in 3D (Phase 2)

`src/features/sentry/SceneActors.tsx` renders each subject in `src/config/subjects.ts` (default: `SUBJECT 01` ← annotation dataset `person_01`) as a volumetric humanoid in the room. It's driven only by the master clock, so play, pause, seek and speed changes are deterministic, and the subject occupies the same spot in every camera mode.

Trajectory (`src/features/sentry/trajectory.ts`, tunables in `trajectoryConfig`):
- Observations within `clusterWindow` (0.2 s) count as simultaneous and are **fused**: a manual top-down correction beats a video click, which beats future automatic detections. Same-priority disagreements are resolved by the surrounding track, and the rest are combined by a weighted mean (σ comes from each camera's projection geometry). Source camera IDs are kept.
- **Outliers** are rejected, with a stated reason, when a sample lies far off the path between its neighbours and reaching it would need more than `maxSpeed` (3 m/s). See the verdicts via `buildTrajectory(...).verdicts`.
- A cubic Hermite curve passes exactly through the fused samples; segments longer than `gapSeconds` are straight lines marked **ESTIMATED** (amber outline and label, plus an incident-log event).
- The subject is hidden before the first and after the last observation. Facing comes from movement, and the walk cycle comes from distance travelled.

Store: the header subject count, entry/gap/exit events (from real annotations only), live selection details (click the subject), and **X**-ray shows the subject through walls.
CCTV view → **TRACKING DIAGNOSTICS** ghosts the real recording and marks the annotated feet (orange) and the projected 3D subject (cyan) with their pixel error.

## Cross-camera evidence & X-ray (Phase 3)

**Evidence ≠ recording ≠ field of view.** A camera only counts as seeing a person when there is real evidence:
- Every feet click in the annotation panel is implicit **observed** evidence for that camera at that master time.
- Explicit **visibility marks**: in ANNOTATE SUBJECT, the "CAM 0X sees person?" row has OBSERVED / OCCLUDED / OUT OF FRAME / UNKNOWN for the current camera and frame. A mark holds until the next evidence in that camera. Marks are stored in `src/data/person-annotations.json` (`visibility: [...]`) alongside the observations.

Per camera at master time *t* (`src/features/sentry/evidence.ts`, tunables `evidenceHold` 0.5 s / `evidenceBridge` 2 s in `config/subjects.ts`):

| State | Meaning |
|---|---|
| TRACKING | within ±0.5 s of an observation in this camera, or between two of them ≤ 2 s apart |
| OCCLUDED / OUT OF FRAME / UNKNOWN | explicit mark (holds until the next evidence) |
| NO DETECTION | seen earlier in this camera, no current evidence |
| NO EVIDENCE / NOT RECORDING | never observed here / no footage at *t* |

Person status: **OBSERVED** (≥ 1 camera tracking, listed by name) → otherwise **ESTIMATED** (with last-seen camera and time) or **LAST SEEN** after the final observation. An unobserved position is never shown as confirmed. The body and label turn amber when not observed.

Where it shows: the **Camera evidence** panel (bottom-right of the 3D view; click a camera to view through it; **LOCATE** points the free camera at the person); camera markers and CCTV feed badges (◉ TRACKING pulses); dashed sight lines from tracking cameras to the person; the trail is cyan where observed and amber where estimated.

**X-ray** (header toggle or **X**): each body part gets a fresnel glow shell parented to the animated limbs. It is drawn with `depthFunc: GreaterDepth`, so it appears only where scanned geometry hides the body. Scene depth testing is otherwise unchanged. Sight lines are drawn through walls while X-ray is on.

Demo moment (verified in the real footage): **25.35 s**. CAM 01 is out of frame (person beside or below its mount), CAM 02 is tracking, so PERSON 01 is OBSERVED. Free-camera spot where they stand behind the bin and table: LOCATE, or `focusFreeCamera([1.2, 0.9, -2.2], [-0.94, 0.95, -6.06])` from dev tools.

## Real appearance (segmented footage in 3D)

The **Camera evidence** panel has a **SUBJECT** selector:
- **REAL APPEARANCE** (default): the person is drawn with their actual segmented pixels.
- **TRACKING DEBUG:** the generic avatar.

How REAL APPEARANCE works (`src/features/reconstruction/`):
- Per master-time frame, the crop is placed on a vertical plane at the tracked position, facing its **source camera**, and projectively textured from that camera.
  - Seen from the source camera it reproduces the footage exactly.
  - From elsewhere it is a flat cut-out at the person's real location.
  - Nothing is invented for unseen sides.
- **SOURCE:** AUTO picks the camera closest to your viewing direction, with hysteresis; C1–C4 force one.
- **Labels:** **OBSERVED VIEW** (≤3° from the source camera) or **RECONSTRUCTED PERSPECTIVE** (with the angle); above 45° a low-support warning is shown.
- The LiDAR room occludes the cut-out. **X-ray** shows the real silhouette in cyan wherever geometry hides it.
- Outside processed clips, the avatar is shown automatically.
- A usable segmentation in a camera counts as observed evidence for that camera.

Crops are generated locally and are **not committed**, because they are footage of a real person. From `experiments/reconstruction/`:

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.lock.txt   # Homebrew Python 3.12 (needs lzma)
curl -L -o checkpoints/sam2.1_hiera_small.pt https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_small.pt
.venv/bin/python preprocess/extract_clip.py --clip clip01 --t0 8.6 --t1 10.4 --fps 15 --cams cam1,cam2
# data/clip01/track.json: tracked boxes per frame (exported from the app's trajectory; see segmentation/segment_sam2.py)
.venv/bin/python segmentation/segment_sam2.py --clip clip01 --cams cam1,cam2 --test   # check 3 frames first
.venv/bin/python segmentation/segment_sam2.py --clip clip01 --cams cam1,cam2
.venv/bin/python segmentation/background_plate.py --cams cam1,cam2
.venv/bin/python segmentation/export_sprites.py --clip clip01 --cams cam1,cam2      # -> public/reconstruction/clip01/
```

Review `data/<clip>/review_<cam>.jpg`. To override a bad mask, put a PNG in `data/<clip>/masks_manual/<cam>/<k>.png`.

## Camera sync

Current offsets were measured from audio, using three claps heard by all four cameras plus GCC-PHAT (see `experiments/reconstruction/REPORT.md`). The earlier manual values are kept in `experiments/reconstruction/calibration/camera-sync.manual-original.json`, and annotations were re-timed to keep their video frames.

Open with the **SYNC** button in the CCTV panel header (or press **Y**).
1. Scrub or frame-step the master time to a sharp moment that every camera sees (a clap, a door closing, an object set down).
2. Type each camera's offset, or nudge it (±1 s / ±0.1 s / ±1 frame), until all four previews show the same instant. Changes apply immediately.
3. Offsets auto-save to this browser. **SAVE TO PROJECT** writes them to `src/config/camera-sync.json` (dev server); commit it so the whole team shares them. **COPY JSON** / **RESET** (revert to the file) are also available.

Clips that haven't started at the current master time show "NOT RECORDING YET" (parked on frame 0); clips past their end show "RECORDING ENDED". The timeline's thin lanes show each camera's covered range.
- **`incident.ts`**: incident name, recording start time (wall-clock display), event type → color mapping.

## Controls

| | |
|---|---|
| Free cam | click scene = mouse look (pointer lock), **WASD** move, **Space/E** up, **Shift/Q** down, **Ctrl** sprint, wheel = speed, **Esc** release |
| Modes | **F** free · **O** orbit · **T** top-down · **1–4** view through CCTV camera · **R** reset view |
| Replay | **K** (or Space outside free cam) play/pause · **←/→** ±5 s (Shift ±1 s) |
| Calibrate (CCTV view) | drag = aim · wheel = FOV · **WASD** move · **Q/E** down/up · arrows pan/tilt · **[ ]** FOV · **, .** roll · **Shift** fine |
| Toggles | **X** X-ray · **M** Sentry Mode · **C** coverage frustums · **H** ceiling · **Y** camera sync · **Esc** close overlay |

Click a camera marker in the 3D view to look through it (its feed highlights). Click a feed to enlarge it over the viewport (it is also linked to its 3D marker), and use 👁 to view through that camera.

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
  cameraOffsets: Record<CameraId, number>;  // live sync offsets
}
```

- Derive **all** state from `currentTime` (deterministic seeking). For per-frame reads without re-rendering, use `useReplayStore.getState().currentTime` inside `useFrame`.
- Push data into the shell through the store:
  - `useReplayStore.getState().setEvents(events)`: timeline markers, incident log, jump-to-event
  - `setActiveSubjectCount(n)`: header counter
  - `setSelectedEntity({ id, label, kind, details })`: incident panel "Selection"
- Camera IDs are stable: `CAMERA_IDS = ["cam1","cam2","cam3","cam4"]` / `CameraId` (in `types/security.ts`). Use them in `PersonKeyframe.visibleCameras` and in `EntityCameraVisibility` (master time + normalized bbox per camera).
- Video ↔ master time: `useReplayStore.getState().getVideoTime(cameraId, masterTime?)` and `getCameraCoverage(masterTime?)`, which tells you which cameras have footage at a given time. The store also has `cameraOffsets` and `feeds` (status + duration per camera). Tracking detected in a video at time `v` happened at master time `v - offset`.
- Real-person annotations: `PersonObservation` / `PersonAnnotationDataset` (types/security.ts), live in `useAnnotationStore` (`features/annotation/`), committed in `src/data/person-annotations.json`. They are master-time floor positions from human clicks, not tracking output.
- Coordinates: meters, Y-up, room floor at y = 0, same space as `config/cameras.ts`.
- Dev console: `window.__sentry.replay.getState()` / `.view` / `.viewport.camera`.

## AI Investigator (NVIDIA Nemotron)

An autonomous, tool-calling investigation agent (`server/investigator.ts`, served by the Vite dev server at `POST /api/investigate`).

1. `cp .env.example .env` and set `NVIDIA_API_KEY` (server-side only — never `VITE_`-prefixed). Optional `NVIDIA_MODEL` (default `nvidia/nemotron-3-super-120b-a12b`).
2. `npm run dev`, click **AI INVESTIGATOR → ANALYZE INCIDENT**.

Nemotron calls read-only tools over the project's real data (`getIncidentOverview`, `getIncidentEvents`, `getSubjectTrajectory`, `getCameraObservations`, `getObjectMovements`, `getEvidenceAtTime`, `getSpatialContext`) and finishes with `createInvestigationReport`, which is schema-validated (camera IDs, timestamps and event IDs must exist). The panel streams the real tool trace; clicking a report event seeks the shared master timeline. No footage is sent — only compact structured metadata. Bounded loop: 12 model turns / 16 tool calls, 90 s timeouts, retries on 429/5xx.
