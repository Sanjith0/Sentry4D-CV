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

## The subject in 3D (reconstructed body with the footage on it)

The **Camera evidence** panel has a **SUBJECT** selector:
- **3D + FOOTAGE** (default): the reconstructed 3D body carrying the real camera pixels of the shown instant. From a camera's own angle the subject is that camera's footage; in between, and on the sides no camera sees, it is the 3D model.
- **3D MODEL:** the same body with only its baked texture (one texture fused over the whole clip).
- **CUT-OUT:** one camera's actual segmented pixels, as a flat cut-out.
- **DEBUG:** the generic avatar (also what is shown when a clip has no reconstruction).

### 3D + FOOTAGE (`src/features/reconstruction/hybridProjection.ts`, `AvatarLayer.tsx`)

The 3D MODEL is complete from every side but soft: its texture is one average over 21 seconds of a person who is about 300 px tall in the footage. The CUT-OUT is as sharp as the footage but flat. This look combines them the way image-based rendering does (view-dependent projective texturing):

- **Surface:** the reconstructed body in the pose of the shown frame, plus the chair he picks up and carries (below).
- **Colour:** every point of the surface is projected into the four camera frames of that instant, with the calibration the body was fitted with. Where a camera really sees the point (inside its cut-out, not hidden behind another part of the body in a depth map rendered from that camera, not at a grazing angle) its pixel is used. Cameras are weighted by how close they are to your viewing direction, so the camera you look along wins and the hand-over between two cameras is continuous while you orbit. Of two cameras far from your viewing direction the nearer one counts more, so the view between two cameras is not a double exposure of both. Away from a camera only what it saw within about 30° of square on is used in full, and nothing it saw at more than 53°: a slanted surface lies within a few pixels of an outline, where the pixel may as well be the wall or the chair beside it. At a camera, its cut-out lies over that blend as it is, as a layer of its own that is complete within 4.5° and gone at 11°.
- **Fill:** points no camera sees at that instant keep the baked texture of the 3D MODEL.
- **Tone:** a camera films a part of the body lighter or darker than that texture holds it (the back of the hoodie under the ceiling lights while he bends over the table). `tone.py` measures the difference per cut-out and body part (18 parts). Away from a camera, the viewer uses it to decide which footage pixels belong on the body (brightness and hue against the texture in that camera's tone, stricter along the rim of the cut-out, where the wall behind him tints the pixels), and it gives the fill the tone of the footage beside it, so the parts no camera shows do not stand out as dark patches and the pixels of two cameras meet in one tone. At a camera, its pixels are the recorded ones, unchanged.
- **Outline:** within 5° of a camera the silhouette is the footage's own. Slivers of the body outside that camera's cut-out are trimmed, and cut-out pixels the mesh does not cover (hair, loose cloth, fingers) are drawn on a card that follows the depth of the body. Both fade out by 12°, where the outline of the mesh takes over. A part the cut-out lacks because furniture stood in front of it (shins behind a table) is not trimmed: it is drawn from the other cameras or the 3D MODEL, so the body has no hole there when you stand closer than the furniture. Along such a part the rim of the cut-out is part furniture (the sofa's orange across a knee): `rims.py` replaces its colours with the person's own from a few pixels further in, the last 4 px are not projected, and the card stops short of it, so the body carries neither a line of the sofa nor a ledge where the cut-out ends.
- **Registration:** where a camera's calibration is weakest (the person one or two metres from the wide-angle lens of CAM 01, or entering a frame at its edge) the fitted body and that camera's cut-out are more than 100 px apart in the worst frames, and footage would land on the wrong part of the body. `register.py` measures, per cut-out, the scale and shift that put it back on the body (needed for 128 of the 1077 cut-outs of clip02). 17 cut-outs that show only a sliver of the person or still disagree with the body are not projected; the body shows the other cameras and its baked texture there.
- **The same frame, always:** pose and pixels both come from the master time, so pausing, scrubbing or stepping shows exactly what playing shows. While the cut-outs of a frame are still downloading, the last complete frame (at most 3 frames back) stays on screen.
- **Labelled as what it is:** **OBSERVED VIEW** within 6° of a camera, otherwise **3D BODY + FOOTAGE**, with the number of cameras that contribute real pixels at that instant and the nearest camera's angle from your view. The LiDAR room occludes the subject; **X-ray** works as before.

**The chair.** From 15 s he holds a chair, at 18.9 s he lifts it and from 19.8 s he carries it out; a body model alone shows empty hands. `chair.py` reconstructs the chair as a rigid object: a proxy of the café chair (seat, slatted backrest, four legs, with dimensions fitted to the views in which it stands alone) and one position and orientation per frame (standing, pulled, lifted, carried in both hands). The viewer draws it like the body, piece by piece (seat, backrest, each leg in six segments): real pixels for every piece a camera's cut-out shows, the grey proxy for the pieces it lacks (`register.py` decides that per cut-out), so the chair has its seat and four legs from every side in both 3D looks. The proxy's two greys are measured from the footage (panels and legs separately), and away from a camera a leg, which is a few pixels wide, only takes footage pixels that look like a leg and not the trousers behind it. The chair is silver metal with a slight gloss, so the proxy is not shaded as one flat grey: its slats have rounded edges (a normal map), its legs are lit as round tubes, and its colour follows what the metal would mirror in this room (floor, lit ceiling, daylight from the glass wall, the ceiling lights). That applies to the proxy's own colour only; footage pixels on the chair stay as recorded. With **WIRE** on, the chair is a wireframe like the room (a line mesh of its own in the GLB, drawn a little stronger than the room's lines so it can be told apart from the furniture behind it), and the person stays solid without the chair's pixels on him. The laptop he puts on the seat is not modelled.

Limits (with frames and angles in `experiments/reconstruction/avatar/README.md`, "Limits and upgrade paths"):

- The head is 30 to 40 px wide in the footage, so that is the sharpness of the face from a camera's angle. From about 6° off a camera the face is softer: where the camera saw the head at a slant (under the jaw, the far cheek) the 3D MODEL's blurred face shows, for example as a dark arc under the chin.
- The lower body leaves the frame of CAM 01 and CAM 04 when he is close to them. What is outside a frame or behind furniture is the 3D model or another camera, with a visible step in sharpness and width where it meets the footage (usually at knee or thigh height).
- Between two cameras the hand-over shows: their pixels meet in one tone, but not in one sharpness (a seam down his back at 14.2 s, 20° to 30° from CAM 01). Between 5° and 12° from a camera, slivers of the body outside its cut-out are half transparent.
- A cut-out that contains something else puts it on the body next to that camera (the bottles on the table in front of his legs at 8.2 s, a leaf of the plant at 17.5 s, both next to CAM 02).
- The chair's pose is approximate while it is carried (2 to 3 cm, about 8°). Its thin legs are partly missing from the cut-outs. Where a cut-out lacks a leg it is the grey proxy, which can stand a little apart from the seat and can change between footage and proxy from one frame to the next. That also happens at a camera's own position: from CAM 01 the two legs on the right of the picture are separate grey bars below the seat from 20.4 s to 21.0 s and the long leg on the left ends half-way at 23.0 s, while from 21.1 s to 22.9 s the chair there follows the recording closely.

### 3D MODEL (`src/features/reconstruction/AvatarLayer.tsx`)

The person used to be drawn as the cut-out pushed forward by a height map of its own silhouette: exact from the source camera, an inflated blob from anywhere else, and a different blob every time the source camera switched. The 3D MODEL replaced that with a real reconstruction, and it is the surface the 3D + FOOTAGE look paints on:

- **One body for the whole clip.** A parametric human body is fitted to the 2D keypoints and SAM 2 silhouettes of all four cameras over all frames: one shape, one clothing layer, one texture, and per frame only the root and the joint angles. It is a normal skinned GLB with a baked animation in room coordinates (`public/reconstruction/<clip>/avatar/subject-01.glb` + `avatar.json`).
- **The same pose at the same time, always.** The pose is set from the master time (`mixer.setTime(masterTime − t0)`), so pausing, scrubbing or stepping backwards shows exactly what playing does. Nothing switches with the viewing angle.
- **Texture is footage.** Every texel is the robust consensus of the camera pixels that saw it over the clip; surface that no camera saw (20 % on clip02) is filled from neighbouring / mirrored texture. The cameras are brought to a common colour with one offset per camera and channel, so dark clothing is the same neutral dark whichever camera a texel came from.
- **It drives the track.** Where the body exists, the subject's floor position, heading, ring and trail follow it instead of the sparse manual annotations (`refineTrajectory` in `useSubjectTracks.ts`); presence and camera evidence still come from the annotations.
- **Labelled as what it is:** the panel shows **RECONSTRUCTED 3D BODY** with the number of cameras the pose is fitted from at that instant (cameras with a usable detection of the body, which can be fewer than the cameras marked as tracking), and says so when there is none and the pose is carried from neighbouring frames.

How it is built, what is measured against the footage and what is inferred: `experiments/reconstruction/avatar/README.md`. Measured on clip02 (315 frames, 1077 camera views): median keypoint error 2.4 to 4.1 px (1.4 to 2.4 cm on the subject) per camera, silhouette IoU 0.79 to 0.88, planted feet move 0.3 mm per frame, no joint beyond its limits. Limits: the face is a blurred average in this look; fingers and cloth wrinkles are not resolved.

```bash
cd experiments/reconstruction/avatar      # after the CUT-OUT steps below; CPU only, about 23 min for clip02 (+ 7 min for the chair)
PY=../.venv-avatar/bin/python             # venv and the two ONNX models: see avatar/README.md
export AVATAR_MODELS=../models
for s in pose2d calibrate fit shape refine shape texture chair register rims tone export validate export; do $PY $s.py --clip clip02 || break; done
```

### CUT-OUT (segmented footage in 3D)

How CUT-OUT works (`src/features/reconstruction/AppearanceLayer.tsx`):
- Per master-time frame, the crop is placed on a vertical plane at the tracked position, facing its **source camera**, and projectively textured from that camera.
  - Seen from the source camera it reproduces the footage exactly, except for the rim of a cut-out along furniture that hides the rest of the body: the avatar pipeline (`avatar/rims.py`) repaints it with the person's own colour, a few hundred pixels in about half of the cut-outs of clip02.
  - From elsewhere it is a flat cut-out at the person's real location.
  - Nothing is invented for unseen sides.
- **SOURCE:** AUTO picks the camera closest to your viewing direction, with hysteresis; C1–C4 force one.
- **Labels:** **OBSERVED VIEW** (≤3° from the source camera) or **RECONSTRUCTED PERSPECTIVE** (with the angle); above 45° a low-support warning is shown.
- The LiDAR room occludes the cut-out. **X-ray** shows the real silhouette in cyan wherever geometry hides it.
- Outside processed clips, the debug avatar is shown automatically.
- A usable segmentation in a camera counts as observed evidence for that camera.

`public/reconstruction/` is git-ignored because it is derived footage of a real person; the cut-outs and the reconstructed body of the demo clips were added explicitly (`git add -f`) so that the hosted demo can show them. To regenerate the cut-outs, from `experiments/reconstruction/`:

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

## Demo mode

**DEMO MODE** in the header (or opening the app with `?demo` in the address, e.g. `/?demo`) plays a 25-second automatic walkthrough of the viewer and then puts everything back the way it was (time, play state, camera, view options):

| At | What it shows |
|---|---|
| 0.0 s | the four CCTV recordings side by side, already playing; the subject picked out in each one (SAM 2.1 mask) |
| 2.0 s | SUBJECT LOCKED: push into CAM 01, then the 3D view flies through the room to CAM 02, 03, 04 and back to 01, the way the camera buttons move it; each camera's recording is up for a beat (dissolving out as it leaves, back in on arrival) and the flights keep moving; the 3D view carries the recordings' exposure for the whole pass (so the dissolves don't brighten) plus their grain (X-ray tint, recordings at 2×) |
| 6.0 s | REAL FOOTAGE 100% → 0% on CAM 01: the 3D reconstruction under the same camera, same instant |
| 7.6 s | LIDAR DIGITAL TWIN: the room melts to its wireframe (1.4 s) while the subject keeps walking (easing into 0.55x slow motion) |
| 9.0 s | the subject fades out as a hologram mid-stride; the camera swings out while time rewinds and the wireframe room thins away under a descending scan grid |
| 10.45 s | the bare floor grid and the four cameras' coverage; the room is rebuilt from the scan, and at 11.3 s the replay starts (1.6x): the subject walks in while his whole path is drawn on the floor, the part he has walked in cyan and the part still ahead of him in red; his way back runs along his way in, so that stretch is one line (already cyan when he comes back over it), and the path clears under his feet |
| 12.3 s | straight above the room as he walks (entry, dwell and exit labels, metres walked so far) |
| 13.8 s | the replay carries on (1.6x while he walks, up to 2.7x only while he stands at the table) while the camera orbits the whole room and comes down to the subject (the scanned frames of the window wall dissolve, so the room stays open to the camera as it passes outside) |
| 19.1 s | wireframe room, the subject alone with the tracking readout; the camera closes in and holds near the CCTV cameras' lines of sight (where he is shown from real footage), hurrying across the angles between them |
| 21.8 s | slow motion (0.4×): a free camera circles the subject and walks with him as he carries the chair on: real footage / X-ray / full 3D, with the room re-textured under the full 3D; it comes to rest in front of him, on CAM 01's line of sight (so his face is his own recorded pixels, not a blend of two cameras), as he walks towards the camera |
| 23.8 s | end card over that front view, with a slow push in (stays 5 s, then the demo closes itself) |

**Esc** leaves at any time (on a touch screen: tap, then EXIT DEMO). For a clean screen recording put the browser in full screen first. The walkthrough is built for a landscape window; an upright phone gets a simplified stacked layout.

The whole walkthrough is data: `src/features/demo/demoScript.ts` holds pure functions of the demo clock (camera path, incident time, room build, looks, captions), `DemoDirector.tsx` (inside the canvas) applies them every frame, `DemoWall.tsx` draws the four-feed wall and each camera's recording during the pass on a 2D canvas, `DemoPath.tsx` is the two-colour path on the floor (the fused track, baked into a distance field), `DemoOverlay.tsx` is the HUD, `labelFit.ts` keeps the scene's floating labels clear of the frame's edge, the captions and each other while the camera flies. Because nothing depends on anything but the clock, the walkthrough can also be stepped frame by frame: in a dev build `window.__sentryDemo.step(seconds)` shows any moment of it.

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
  features/demo/               demo mode: the scripted 25-second walkthrough (see Demo mode)
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

### Deploying to Vercel

`vercel.json` builds the static app (`dist/`) and deploys `api/investigate.mjs`, the AI Investigator agent pre-bundled into one file from `server/vercel/entry.ts` (rebuild it with `npm run build:api` after changing the server code or incident data).

In the Vercel project settings, set **Environment Variables**: `NVIDIA_API_KEY` (required), `NVIDIA_MODEL`, `NVIDIA_FALLBACK_MODEL`, `NVIDIA_BASE_URL` (optional). The key stays server-side.

The CCTV recordings (`public/videos/*.mov`) are not in git (private footage, about 240 MB). Without them the 3D room, tracking and AI Investigator work, but the CCTV feeds are empty. To show the feeds on a hosted demo, upload the videos to a private store and point `videoUrl` in `src/config/cameras.ts` at them.
