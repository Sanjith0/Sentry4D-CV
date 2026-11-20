# Subject avatar: one articulated, clothed, textured 3D body from the four CCTV cameras

This folder turns the synchronized footage of a clip into **one** 3D model of the tracked person that is
valid for every frame: a skinned mesh with a baked animation in room coordinates
(`public/reconstruction/<clip>/avatar/subject-01.glb`) plus a small sidecar (`avatar.json`).
The viewer's default **3D MODEL** mode (`src/features/reconstruction/AvatarLayer.tsx`) plays it.

## Why the person used to look like a blob

The previous renderer (`AppearanceLayer.tsx`, still available as **FOOTAGE**) is a billboard, not a
reconstruction:

- each frame it takes **one** camera's RGBA cut-out, puts it on a vertical plane at the tracked floor point and
  pushes the pixels forward by a height map computed from the silhouette alone
  (`export_sprites.py`: `sqrt(2·r0·dist − dist²)`, i.e. a pillow that is thickest in the middle of the mask);
- the back is the mean colour of the crop; nothing is fused across cameras or across time;
- the source camera switches with the viewing angle, so shape, size and position jump while orbiting or scrubbing;
- the plane stands on the app's sparse hand-annotated track, which is a median 0.23 m (p95 0.67 m) away from
  where the person actually is.

Seen from its source camera the result is exact; from anywhere else it is an inflated silhouette, which is the
blob. No amount of tuning fixes that, because the representation holds no 3D information about the person.

A feed-forward geometry model such as VGGT does not fix it either. It gives per-view depth / point maps for a
rigid scene; its authors list substantial non-rigid motion as a failure case, a walking person seen by four wide
baseline cameras is exactly that, and four partial depth shells per frame are still not one body that is the same
object from frame to frame. What a moving person needs is a model of the person.

## Approach

Fit **one** parametric human body to **all four cameras over the whole clip**, then add what the footage shows
on top of it:

| # | script | what it does | main output (`data/<clip>/avatar/`) |
|---|---|---|---|
| 1 | `pose2d.py` | RTMW whole-body 2D keypoints (133) for the subject in every camera and frame, flip-tested, gated by the SAM 2 crop | `kp2d.npz` |
| 2 | `calibrate.py` | bundle adjustment of the four cameras using the person's keypoints as targets, anchored to the app calibration and the room floor; also the clock offset of each camera (the app's `camera-poses.json` is not modified) | `cameras_refined.json` |
| 3 | `fit.py` | one body shape (Anny phenotypes + scale) and per-frame root + joint angles, fitted to the keypoints each camera can really see, with temporal smoothness, joint limits, floor contact and no foot sliding | `fit.npz`, `fit_keypoints.npz` |
| 4 | `shape.py` | clothing layer: one static offset per vertex along the rest normal so the posed surface explains the SAM 2 silhouettes of all views (hoodie, joggers, shoes, hair) | `shape.npz` |
| 4b | `refine.py` | pose refinement against the silhouettes (stage E), ground contact on the scanned floor (stage F), polish (stage G); then `shape.py` again | `fit.npz` |
| 5 | `texture.py` | 1024² texture: every texel is projected into every view that sees it (z-buffered) and fused over 4 cameras × 315 frames with per-camera colour matching and robust consensus; never-seen texels are filled from neighbouring / mirrored surface | `texture.png` |
| 6 | `export.py` | skinned GLB (52 joints, ≤ 4 weights per vertex, one animation key per frame in room coordinates) + `avatar.json` | `public/reconstruction/<clip>/avatar/` |
| 7 | `validate.py` | measures the exported GLB against every camera and frame | `metrics.json` |

Support files: `common.py` (paths, camera model identical to the app's), `body.py` (Anny rest state, own FK / linear
blend skinning that matches glTF exactly), `posefit.py` (pose parametrisation, joint limits, losses), `triangulate.py`,
`masks.py` (SAM 2 masks, which detections are on the visible person), `room.py` (scanned floor under the subject),
`render.py` (CPU rasteriser), `gltf_io.py` (GLB writer / reference reader), and the diagnostics `viz.py`, `silviz.py`,
`preview.py`.

The body model is [Anny](https://github.com/naver/anny) (code Apache-2.0, MakeHuman-derived data CC0), with its
Mixamo-compatible rig. The 2D detector is RTMW-L through [rtmlib](https://github.com/Tau-J/rtmlib) (Apache-2.0).
Everything runs on CPU. For the 21 s clip on 4 cores: 2D keypoints about 10 min, then calibrate 40 s, fit 76 s,
shape 72 s (twice), refine 226 s, texture 250 s, export 3 s, validate 24 s; about 23 minutes in all.

### Why the result cannot flicker or change identity

Shape, clothing offsets, UV layout and texture are single objects shared by all frames; only the 22 animated
joints and the root move. Playback sets the pose with `mixer.setTime(masterTime − t0)`, so a given master time
always shows exactly the same pose, whether you play, pause, scrub or step backwards.

Checked in the running viewer (headless Chromium, 176 seeks to 132 random master times, forwards and backwards):
wherever the subject is shown, the reconstructed body is what is drawn; its root joint is within 0.08 mm of the
exported motion for that time (the sidecar is rounded to 0.1 mm); and returning to a time gives the identical pose.

## What keeps the pose right in every frame

A fit that only minimises reprojection error looks right on average and wrong in the frames where the evidence is
bad. Each rule below removes one failure that was found by looking at those frames.

**Only detections of what a camera can see** (`masks.hidden_keypoints`). A top-down pose network returns every
keypoint, seen or not, and reports guesses with full confidence. Two kinds are dropped: keypoints pinned to the
image border where a limb leaves the frame, and keypoints lying outside the SAM 2 mask of their view by more than
2 % of the person box (double that for the face, half for knees, ankles and feet), which is where the network
guesses a limb hidden behind furniture. Short gaps are closed so that evidence does not flicker. The mask test is
skipped where the mask is no evidence: beyond the box the exporter clipped it to (needs `data/<clip>/track.json`)
and in the few views where SAM 2 has drifted off the person. On clip02 this discards 2,280 confident detections.

**Joint limits** (`posefit.py`, `fit.py`). Knees and elbows are hinges; the ankle has a range
(about 29° up, 52° down, 32° toes in / out, 26° roll); a thigh turns at most 60° about its own axis; no joint
rotates faster than about twice what brisk walking reaches (knee 13 rad/s, elbow 14, hip 8, ...), because a faster
change is a limb flipping when a detection comes or goes; and a limb that no camera observes holds its pose
instead of being swung by the smoothness terms.

**Keypoints first, silhouettes second** (`refine.py`, stage E). The silhouettes fix what keypoints leave open: the
head when the face turns away, wrists inside sleeves, a torso seen end-on. But a silhouette does not say which
part of the body fills it, and it is not always only the body: SAM 2 follows the chair and the laptop the subject
picks up. Left alone, the outline of the chair in one camera pulled a leg 30 cm off the shoe that another camera
sees plainly. So:

- *anchor*: a detection that the keypoint-only fit explains (within 1.5 σ) may not end up more than half a σ
  farther from the model than it was;
- *near*: mask-outline samples farther than about 10 cm from the keypoint-only fit never attract the surface;
- *steady*: a silhouette is cut out anew in every frame and its noise shakes the body, so no joint may accelerate
  more than it did in the keypoint-only fit (2 mm of slack; feet are exempt around a foot plant, which is a real
  jolt);
- face keypoints are ignored in views that see the back of the head, where they are guesses that kept the head too
  high while the subject bends over the table;
- stages E and F end with a decaying step size and an L-BFGS polish: with a constant step the optimiser itself
  left a few millimetres of frame-to-frame noise in every joint.

**Feet on the floor** (`refine.py`, stage F). Before this stage a planted foot creeps by about 4 mm per frame,
which reads as skating from close by. Planted intervals are found from the heel and ball markers of each
shoe (within 2 cm of the floor and slower than 1.5 cm per frame for at least 3 frames), and then: no vertex of
the clothed shoes below the floor; a planted heel / ball does not move for the whole interval; a planted heel /
ball touches the floor, and a heel that stays planted carries weight, so the ball of that foot is down too. The
last rule decides the pose of a foot whose toes no camera sees, e.g. under the sofa bench while the subject leans
on the table.

**The floor the viewer draws** (`room.py`, `Fitter.set_floor`). The phone LiDAR scan of the room is not flat: along
the subject's path its floor is between −1.5 and +3.7 cm from the plane the cameras are calibrated to. The cameras
do not see that relief (triangulated soles sit at the same height wherever the scan puts the floor), so it is
drift of the scan, not a step in the room. Each frame is therefore fitted where the cameras see the body and
*shown* lifted by the scanned floor height under it (`lift` in `fit.npz`, added by `export.py`): the shoes stand
on the floor that is drawn, and nothing that is compared with an image is moved.

## Run

```bash
cd experiments/reconstruction
python3.12 -m venv .venv-avatar
.venv-avatar/bin/pip install --extra-index-url https://download.pytorch.org/whl/cpu -r avatar/requirements.txt

# 2D models (ONNX, CPU)
mkdir -p models/yolox_m models/rtmw_l_384
curl -L -o /tmp/yolox.zip https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_m_8xb8-300e_humanart-c2c7a14a.zip
curl -L -o /tmp/rtmw.zip  https://download.openmmlab.com/mmpose/v1/projects/rtmw/onnx_sdk/rtmw-dw-x-l_simcc-cocktail14_270e-384x288_20231122.zip
unzip -q /tmp/yolox.zip -d models/yolox_m && unzip -q /tmp/rtmw.zip -d models/rtmw_l_384

# inputs that must already exist for the clip (see ../run_segment_export.sh):
#   data/<clip>/frames/<cam>/<k>.png          synchronized frames (preprocess/extract_clip.py)
#   data/<clip>/track.json                    tracked boxes (the masks are only trusted inside them)
#   public/reconstruction/<clip>/manifest.json + RGBA crops (segmentation/export_sprites.py)
#   public/assets/room.glb                    the room scan (floor under the subject)

cd avatar && PY=../.venv-avatar/bin/python
$PY pose2d.py    --clip clip02 --models ../models
$PY calibrate.py --clip clip02
$PY fit.py       --clip clip02            # --gender 0 = male template (default), 1 = female
$PY shape.py     --clip clip02
$PY refine.py    --clip clip02
$PY shape.py     --clip clip02
$PY texture.py   --clip clip02
$PY export.py    --clip clip02
$PY validate.py  --clip clip02 --sheet /tmp/avatar_check.jpg
$PY export.py    --clip clip02            # again, to embed metrics.json in avatar.json
```

Diagnostics: `preview.py --frame 170 --out x.jpg` (turntable of any frame, `-1` = rest pose),
`silviz.py --frames 60,150,200 --out x.jpg` (mask outline in green, model outline in red, per camera).
`refine.py --w-anchor 0 --w-steady 0` shows what the silhouettes do when nothing holds them back.

## Results on clip02 (4.2 s – 25.2 s, 315 frames, 966 camera views)

Every number is measured on the exported GLB (evaluated the way a glTF viewer does), against the footage:

| | cam1 | cam2 | cam3 | cam4 |
|---|---|---|---|---|
| views with a SAM 2 mask | 221 | 300 | 304 | 139 |
| 2D keypoint error, median (px) | 3.1 | 3.2 | 2.4 | 4.1 |
| the same on the subject, median / p90 (cm) | 2.4 / 5.4 | 2.1 / 5.1 | 2.0 / 4.7 | 1.4 / 4.4 |
| confident detections discarded (not on the visible person) | 110 | 1077 | 595 | 498 |
| confident detections the keypoint-only fit explains, lost by the delivered body | 1 | 4 | 0 | 1 |
| silhouette IoU, median (p10) | 0.90 (0.84) | 0.80 (0.64) | 0.87 (0.51) | 0.84 (0.74) |
| mask covered by the body (recall), median | 0.97 | 0.95 | 0.94 | 0.91 |
| body inside the mask (precision), median | 0.93 | 0.84 | 0.95 | 0.90 |
| re-rendered texture vs footage, mean abs. error (0-255) / PSNR | 18.1 / 18.5 dB | 20.9 / 17.8 dB | 19.8 / 18.4 dB | 19.0 / 18.2 dB |

- **Asset**: 1.18 MB GLB, 14,898 vertices, 27,420 triangles, 315 animation keys; read back like a viewer does, it reproduces the fitted surface to 0.0018 mm.
- **One body for all frames**: identical topology, UVs and texture; bone lengths change by 0.0005 mm over the clip. Stature 1.79 m (1.83 m with shoes and hair).
- **Detections kept**: 13,632 confident detections are explained within 1 sigma by the keypoint-only fit; the delivered body (after silhouettes and ground contact) misses 6 of them by more than 2 sigma (nose 4, leftEye 1, rightEye 1: face keypoints in views that see the back or the side of the head, which the silhouette stage discounts on purpose). Median residual 0.53 sigma before, 0.59 sigma after.
- **Evidence per frame**: 4 cameras in 140 frames, 3 in 93, 2 in 72, 1 in 8, none in 2.
- **Joint limits**: ankle outside its range in 0 frames; thigh twist at most 54 deg (limit 60, exceeded in 0 frames); joint changes faster than a person can move: 0 (fastest 0.94 x the limit). Joint rotation per frame: median 1.9 deg, p99 19.1, max 33.7.
- **Ground** (scanned room floor (height map)): lowest point of the body -1.6 mm (worst frame) / -0.3 mm (median) relative to the floor, 0 frames more than 5 mm below it; a foot is planted in 99 % of the frames (70 intervals) and moves 0.32 mm per frame while planted (p90 0.89, max 14.05); before the contact stage it crept 3.86 mm per frame.
- **Coverage**: 82 % of the surface was seen by at least one camera at some time (92 % of the atlas texels in two or more of the 966 views, median 141 views per texel).
- **Shake**: frame-to-frame zig-zag of the joints (RMS distance from a local cubic over 5 frames): pelvis 1.7 mm,
  hips 1.8 / 1.9 mm, wrists 5.1 / 4.1 mm, ankles 6.5 / 6.7 mm. The keypoint-only fit has 1.8 mm, 1.8 / 1.9 mm,
  5.5 / 4.3 mm and 5.9 / 5.3 mm; before the *anchor* and *steady* rules and the decaying step, the silhouette stage
  left 4.0 mm in the pelvis and 12.1 / 8.8 mm in the wrists.

How to read these numbers:

- The keypoint error is agreement with a 2D detector, not with ground truth. The keypoint-only fit, which
  optimises nothing else, reaches 2.8 / 2.9 / 2.2 / 3.8 px; the delivered body gives up 0.2 to 0.4 px of that for
  silhouettes and floor contact.
- The silhouette statistics leave out the views whose mask is flagged as containing a carried object. What holds
  them down is furniture: the body is drawn whole, the mask stops at the sofa or the table (precision), and some
  unflagged masks still contain the chair.
- The photometric numbers compare one fused texture with four cameras that differ in exposure and white balance.
- A foot counts as planted while a heel / ball marker is within 2 cm of the floor and moves less than 15 mm per
  frame, so the frame in which a foot lands or lifts off is included: those frames are the 13 to 14 mm maxima.
  Without the first and last frame of each of the 50 intervals of six frames or more, a marker moves 0.28 mm per
  frame in the median (p99 1.4 mm, max 5.0 mm) and drifts 0.7 mm over the interval (p90 1.4 mm, max 4.0 mm).

## What is measured and what is inferred

Measured from the footage:

- where the person is and how the limbs are posed, in every frame in which a camera sees them (multi-view
  keypoints + silhouettes);
- body proportions and stature (one shape for the clip);
- the outline of the clothing (silhouettes from four directions);
- colour of every surface that at least one camera saw at some point in the clip (82 % of the surface).

Inferred (prior, not evidence):

- surface nobody filmed (soles, inner thighs, armpits, top of the head from below): filled from neighbouring and
  mirrored texture;
- limbs hidden in every camera at some moment (the legs behind the sofa while the subject bends over the table):
  placed by the joint limits, the temporal model and the floor rules, e.g. a hidden planted foot is assumed flat
  on the floor;
- anatomy the cameras cannot resolve: fingers (a fixed relaxed curl), facial features (the head is 30–40 px wide in
  the footage, so the face is a blurred average of what was seen), cloth wrinkles (the clothing is rigidly skinned
  to the body and does not swing);
- poses during the 2 frames in which no camera sees the person (the first and the last of the clip) and, largely,
  the 8 frames with a single camera are carried by the temporal model.

The viewer labels this mode **RECONSTRUCTED 3D BODY**; the **FOOTAGE** mode still shows unmodified pixels.

## Limits and upgrade paths

- **"100 % accuracy" is not attainable from four phone cameras** for surfaces they never saw, and the numbers above
  are agreement with the footage, not ground truth: there is no scan of the person to compare against.
- **Carried objects** (laptop, chair) are not modelled: the hands close around nothing. They are kept out of the
  texture by building the starting colour consensus from the frames before anything is picked up, and out of the
  pose by the anchor / near rules above.
- **The body is shown up to 3.7 cm higher than the cameras see it**, where the room scan's floor is that much
  off (see "The floor the viewer draws"). A flatter room scan removes this.
- **Hair bun, hood, drawstrings** exist as texture and as a smooth offset of the head / neck surface, not as separate
  geometry.
- **Lighting is baked** into the texture (the viewer draws it almost unlit, like the room scan).
- **Template sex** is a manual flag (`fit.py --gender`); height and proportions are fitted.
- A stronger initialisation is possible with a single-image mesh-recovery network (for example SAM 3D Body, whose
  checkpoints are gated on Hugging Face and need the owner's own access) feeding the same multi-view fit.
- True per-pixel appearance (wrinkles, cloth motion) needs an animatable Gaussian-splat avatar or 4D Gaussian
  splatting; that needs a CUDA GPU and, for free-viewpoint quality, more cameras than four. The mesh and poses
  produced here are the standard initialisation for such methods.
