# Sentry4D: feasibility report for Atlas-style 4D reconstruction

Date: 2026-11-08. Scope: research, local inspection, measurements, PoC plan. **No reconstruction, cloud job, or large install has been run.**
Checkpoint: tag `checkpoint/pre-4d-pivot` → `29150af` (phases 1–3, also on `origin/main`).

Legend: ✅ verified (measured locally, or read in primary source and independently fact-checked) · 🟡 likely · ⚪ estimate.

---

## A. Current project status

**What works** (all committed and pushed, `29150af`):

| Area | Status | Key files |
|---|---|---|
| LiDAR room | ✅ 4.80×3.13×13.55 m, metric, Y-up, floor y=0, ceiling clip, PERF/BAL/ULTRA | `src/scene/RoomModel.tsx`, `src/config/roomConfig.ts` |
| Camera modes | ✅ free-fly, orbit, top, CCTV (16:9 sensor-frame), in-app calibration → `camera-poses.json` | `src/scene/CameraControls.tsx`, `src/dashboard/CalibrationPanel.tsx` |
| Replay | ✅ single master clock, `videoTime = masterTime + offset`, drift-corrected `<video>` sync, sync panel → `camera-sync.json` | `src/store/useReplayStore.ts`, `src/dashboard/CCTVFeed.tsx` |
| Phase 1 | ✅ click feet → `videoPixelToWorld` floor projection, 25 observations of `person_01` | `src/lib/videoProjection.ts`, `src/features/annotation/*`, `src/data/person-annotations.json` |
| Phase 2 | ✅ deterministic fused trajectory + volumetric humanoid (debug/fallback representation) | `src/features/sentry/trajectory.ts`, `SceneActors.tsx`, `Humanoid.tsx` |
| Phase 3 | ✅ per-camera visibility evidence, OBSERVED/ESTIMATED provenance, occlusion-only X-ray | `src/features/sentry/evidence.ts`, `useEvidence.ts`, `EvidencePanel.tsx` |

**Fixed during this investigation:** CAM 01's `out-of-frame` mark at 4.33 s held until 8.36 s, but the person is visibly in frame at 5.58 s. Added a verified `observed` mark at 5.58 s.

**Incomplete:**
- Sync offsets are wrong by 3–12 frames (§8).
- Calibration is not reconstruction-grade (§7).
- There is no per-pixel human appearance anywhere in the app; the person is still a proxy.

**Preserve:** every item above. The humanoid stays as the X-ray/debug layer and the fallback.

## B. Hardware assessment ✅

- **Machine:** macOS on an Apple **M5 Pro** (16-core GPU, Metal 4), **24 GB** unified memory, 793 GB free disk.
- **CUDA:** none. No NVIDIA GPU, `nvcc` or `nvidia-smi`.
- **Python stack:** Python 3.12 with no numpy, torch or OpenCV system-wide. A scratch venv with numpy only was used for these measurements.
- **ffmpeg:** not installed system-wide. The repo's `ffmpeg-static` build has `zscale`, `tonemap` and `colorspace`, so HLG→SDR conversion is possible without installing anything.
- **Docker:** present.

**Consequence:** every 3DGS/4DGS trainer evaluated (4C4D, videosplat/4DGaussians, Forge4D, GPS-Gaussian, GIGA, LHM++) needs CUDA kernels, so none run on this Mac.
- **Runs locally:** segmentation (SAM 2 on MPS, preliminary; RVM via CoreML), Depth Anything V2 (MPS/CoreML), numpy/OpenCV geometry, splat **rendering** (Spark, WebGL2), and local splat training of **static** scenes only (Brush, OpenSplat Metal).
- **Cloud GPU** (only after approval; the RunPod connector in this session needs authorization first): **A100 40 GB** recommended (4C4D pins CUDA 11.6, which suits Ampere). A 24 GB RTX 4090 is workable at ≤2M Gaussians.
  - Upload: only derived frames, about 135–300 PNGs (≈0.3–1 GB). These show an identifiable person, so the data leaves the machine.
  - Download: renders as mp4, per-frame PLY/SPZ.
  - Cost ⚪: low single-digit $/hour; check current rates.

## C. World Labs Atlas comparison ✅ (fact-checked)

- **What Atlas is:** a generative "omni" world model (autoregressive diffusion transformer). It generates RGB frames, optionally with depth, along camera paths, and fills regions no camera saw.
  - Separate tasks turn posed RGB-D into a **static** SPZ splat (`posedImages2Splats`, 10–20 min, $0.50–$5) and a mesh.
  - Sources: worldlabs.ai/blog/atlas; docs.atlas-beta.worldlabs.ai.
- **Dynamic multiview human reconstruction: not offered.** The beta docs say: "Direct video upload and time control across a changing scene are not currently available"; "moving people … can appear in incompatible positions"; "human faces, articulated subjects … may change in generated views".
  - The most it can do with synchronized cameras is a frozen-time camera move around one instant, which is generated content.
  - The blog says the model can do more for select early-access partners. That is not obtainable within hours.
- **Interface:** API only (waitlisted beta). Inputs are still images. `images2PosedRGBD` re-estimates cameras and does not accept ours. `atlasGenerate` accepts our pinhole cameras plus required context depth. Target resolutions are fixed (1280×720 etc.), with no lens-distortion terms.
- **Not open-source:** no weights and no model code.
  - `worldlabsai/atlas-camera-studio` (MIT) is a camera-path editor and thin API client: one still image → 48 frames → a 4 s, 12 fps mp4. It needs an API key from the waitlist.
  - Marble (generally available API) makes static worlds from images or video, in arbitrary units. It is redundant given our LiDAR scan.
- **What we can reproduce:** the *user experience* (free camera around a real recorded event in a real room) with our own geometry and real pixels. Any Atlas output would have to be labelled **GENERATED** and would require uploading security footage. Not recommended for the core.

## D. Open-source model comparison (all claims fact-checked against repos, papers and issues)

| Repository | Source | Weights | Compute | Views assumed | Approach | Output | Integration | Recommendation |
|---|---|---|---|---|---|---|---|---|
| **4C4D** (yangzf-1023, CVPR'26) | ✅ full | none needed (per-scene); none released | CUDA only (JIT rasterizer, simple-knn, pointops2); pins torch 1.12 / CUDA 11.6; OOM on 24 GB above about 3.5M Gaussians | **4 training views** (N3V/ENeRF/Mobile-Stage subsets; own 4×GoPro rig) | Fudan 4DGS + neural opacity decay; MASt3R init recommended (any `points3D` accepted) | non-standard **4D PLY** (t, scale_t, rotation_r); render.py → mp4 | needs a custom time-slicer to show in Spark | **Best real-4D candidate, cloud-only stretch.** Train with `--training_view 0,1,2,3` and add masks (missing upstream). Issue #14: decay can cause semi-transparency, so try with it off. 2–10 h per 10 s on a 4090 published; ⚪ 1–3 h for our 3 s |
| **videosplat** (Ahmedn1) | ✅ (1–2-day public dump) | none (per-scene) | CUDA only, "16 GB works" | sparse / casual; ships audio sync | 4DGaussians (HexPlane) and others | per-keyframe 3DGS PLY + web viewer | PLY frames → Spark | Viable alternative to 4C4D. Its own Findings report collapse at novel angles. Needs a pose adapter |
| **Forge4D** (zhenliuZJU) | ✅ code | ❌ **"coming soon"**, still unreleased; training ≈1 week on 8×H20 | CUDA, ≥24 GB | 4-view input | feed-forward 4D human Gaussians | per-frame PLY | — | **Not viable** (no weights; inference also needs masks + GT cameras) |
| **Spark** (sparkjsdev, MIT) | ✅ | n/a | WebGL2 browser, runs on the M5 | n/a | **renderer only** | reads .ply/.spz/.splat/.ksplat/.sog | R3F via `extend()`; depth-tests against opaque meshes; per-frame splat swap ~16 B/splat | **Use as the display layer for any splat output.** Caveats: Chrome-on-M-series stutter (#407); transparency vs our X-ray ordering (#182) |
| GIGA (3DV'26) | ✅ | ✅ (MVHumanNet / DNA) | CUDA 12.8, torch ≥2.6 | not stated | feed-forward sparse-view, SMPL-X anchored | renders only (no Gaussian export) | hard | research gamble |
| LHM++ | ✅ | ✅ partly (PLY export only on some variants) | CUDA, 8–16 GB | 1–16 images | feed-forward animatable avatar | 3DGS PLY | Spark | only as a clearly labelled **avatar (GENERATED back-side)** |
| GPS-Gaussian(+) | ✅ | ✅ (v1) | CUDA | stereo pairs from dense rigs | feed-forward | renders between 2 adjacent views | — | not viable (our cameras are opposite corners) |
| 4D-Humans / Multi-HMR / EasyMocap | ✅ | ✅ (SMPL licence, non-commercial) | HMR2 runs on CPU; Multi-HMR asserts CUDA | 1+ | pose regression / multiview SMPL fitting | SMPL params | three.js skinned mesh | proxy geometry for projective texturing (stretch) |
| SAM 2.1 / RVM / BiRefNet | ✅ | ✅ | MPS (SAM2 "preliminary"), CoreML (RVM) | per view | segmentation / matting | masks / alpha | — | **use** (preprocessing for every path) |
| Depth Anything V2 (Small: Apache-2.0) | ✅ | ✅ | MPS / CoreML | per view | monocular depth | depth maps | displaced sprites | **use** for the 2.5D upgrade |

**Excluded on fidelity grounds:** generative sparse-view methods (4DGS-Fixer, GS-GS). They fill unseen content with video-diffusion priors.

**Expected quality of real 4DGS here** ⚪, anchored on 4C4D's paper (held-out views 22–24 dB PSNR on compact, inward-facing 4-view rigs):
- Our rig is worse: the person is seen by 1–2 cameras most of the time, 3–13 m away, at ~1 cm/px, with 70 px calibration error.
- **After calibration is fixed:** a soft, recognisable figure with the right clothing colours within ~10–20° of a source camera; floaters, holes and flat "needles" from top, back or close-up.
- **Without fixing calibration:** a doubled person.

## E. Recommended architecture

```
4 original videos (untouched)
  └─► derived clip: master-time-aligned CFR frames, HLG→SDR, rotation applied        [preprocess/]
        ├─ sync: audio GCC-PHAT + clap transients (MEASURED)                         [§8]
        ├─ masks: SAM2 (MPS) + RVM/BiRefNet alpha; occluder masks from LiDAR depth
        └─ cameras: camera-poses.json → OpenCV/COLMAP (VERIFIED converter)
                     + PnP refinement with k1,k2 against LiDAR landmarks             [§7]
  ├─► Gate test: visual-hull consistency + leave-one-camera-out IoU (Mac, minutes)
  ├─► (pass + approval) cloud: 4C4D/4DGS on the 3 s window, person-masked, LiDAR init
  │      → novel-view mp4 + per-frame PLY → SPZ → Spark in R3F
  └─► fallback, always built: multiview matted "video sprites"
         per-camera RGBA crops at the tracked 3D position, camera-aligned planes,
         view-dependent blending of the 2 nearest cameras (+ optional depth relief)
Sentry4D app (unchanged core): room GLB = metric frame + occluder; master clock drives frame index;
trajectory + evidence = placement + provenance; humanoid = X-ray/debug; original footage always one click away.
```

**Integration boundary.** New `src/features/reconstruction/`, mounted next to `SceneActors`, with nothing replaced:

```ts
type EvidenceClass = "observed" | "reconstructed" | "generated";
interface DynamicSubjectAsset {
  subjectId: string; kind: "video-sprites" | "depth-sprites" | "gaussian-sequence" | "visual-hull";
  timeRange: [number, number]; fps: number;            // master time
  frames: { t: number; uri: string | Record<CameraId, string>; supportingCameras: CameraId[] }[];
  transform?: [number, number, number];                 // room frame; sprites follow the trajectory
  evidence: EvidenceClass;                              // whole-asset class; per-pixel weight shown in UI
  status: "idle" | "loading" | "ready" | "error";
}
```

**Evidence labelling:**
- A source camera's own pixels at its own viewpoint are **OBSERVED**.
- Blends and novel views of multiview data are **RECONSTRUCTED**. The UI shows a "RECONSTRUCTED PERSPECTIVE" badge with per-pixel weight from the nearest camera.
- Unseen surfaces filled by priors (avatars, Atlas, diffusion) are **GENERATED**.
- Trajectory gaps stay **ESTIMATED**, as in Phase 3.

**Performance** ⚪:
- **Sprites:** trivial (≤3 textured quads), 60 fps.
- **Splat flipbook:** 50–100k splats × 45 frames → ~100–250 MB GPU. Pre-decode once; swap on frame change. Fine on an M5 in Safari.

## F. Proof-of-concept plan (one clip)

**Window:** master **8.6 → 10.4 s** (1.8 s, 27 frames at 15 fps). Extend to ~3 s only if the gate test passes. Measured coverage (corrected sync):
- **CAM 01:** full body, unoccluded, 300–450 px tall.
- **CAM 02:** full body, 250–285 px.
- **CAM 03:** distant, ~170–190 px.
- **CAM 04:** does not see the person here.

So this window has **two strong views plus one weak one**. The alternative is 22.5–25.0 s: two views, larger in CAM 01, and it includes the chair carry.

**Prerequisite P1: sync (measured, needs approval to save).**
- CAM 02 **+0.394 s**, CAM 03 **+0.111 s**, CAM 04 **+9.567 s**.
- Method: three clap transients at master 4.99 / 5.61 / 6.35 s, present in all 4 tracks, minus sound travel time. GCC-PHAT agrees to within ±10 ms.
- Saved values (0 / 0 / 9.3) are 12 / 3 / 8 frames off.
- Apply via the SYNC panel → SAVE TO PROJECT, then RE-PROJECT the annotations.

**Prerequisite P2: calibration refinement.**
- Measured: visible 30–80 px edge misalignment in the CAM 01/02 overlays; ultra-wide lenses (hFOV ≈ 97–100° on CAM 01–03) with no distortion model.
- In a tone-mapped CAM 01 frame, long ceiling edges stay straight, so iPhone in-camera correction removes most distortion. The error is therefore mostly pose/FOV, which landmark PnP fixes. Still solve k1/k2 to confirm they come out small.
- Fix: pick 8–12 landmarks per camera (table corners, pillar bases, door frames) as video pixel ↔ LiDAR raycast point pairs.
- Then `cv2.solvePnP` + `calibrateCamera` with fixed principal point, solving k1 and k2.
- **Target <5 px median reprojection.** Report it per camera. Do not overwrite `camera-poses.json` until the error is measured.
- CAM 02 sags ~12 px over 30 s, so use a pose valid for the clip window.

**Smallest test (Gate 2/3, all on the Mac, no cloud):**

```bash
# 0. tools: ffmpeg-static (already in repo node_modules); venv with numpy opencv-python torch sam2 (≈1.5 GB, NEEDS APPROVAL)
FF=node_modules/ffmpeg-static/ffmpeg   # or brew install ffmpeg
# 1. synchronized, tone-mapped CFR frames (derived copies), master 8.6–10.4 s @15 fps
for c in "01 Jason_cam_01.mov 0.000" "02 Jason_Cam_02.MOV 0.394" "03 Jason_cam_03.mov 0.111"; do set -- $c
  START=$(python3 -c "print(8.6+$3)")
  $FF -ss $START -i public/videos/$2 -t 1.8 \
    -vf "zscale=t=linear:npl=203,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p,fps=15" \
    -start_number 0 experiments/reconstruction/data/clip01/images/cam$1_%04d.png
done   # (cam 02 is SDR H.264: drop the tonemap chain for it; ffmpeg auto-applies the rotation flag)
# 2. masks: SAM2 video predictor on MPS, one box prompt per camera from the tracked position → masks/cam$c_%04d.png
# 3. cameras: calibration/export_opencv.py (verified to 0.0004 px vs the app) → COLMAP sparse/0 (PINHOLE; undistort first if k1,k2 solved)
# 4. GATE: carve a 2 cm voxel visual hull in a 1.2×2×1.2 m box around the tracked position from the masks;
#    leave-one-camera-out: project the hull of the other cameras into the held-out one → IoU vs its mask.
#    PASS: person-shaped hull and IoU ≥ 0.6 → request cloud run. FAIL → fallback only.
```

**Expected intermediates:**
- 27×3 PNGs at 1920×1080 SDR.
- 81 masks.
- `cameras_opencv.json` and COLMAP text files.
- `hull_t.ply` per frame.
- An IoU table per held-out camera.

**Stage D/E on cloud** (only after PASS and approval):
- 4C4D with `--training_view 0,1,2` and opacity decay off.
- Init from LiDAR samples plus a box around the person; add a masked L1 + alpha loss (≈20 lines).
- `render.py` from a camera midway between CAM 01 and CAM 02, plus each held-out camera.

**Stage F:** slice the 4D PLY per frame → SPZ → Spark `SplatMesh`, index = `floor((masterTime − 8.6)·15)`.
**Stage G:** compare renders at the source cameras with the real frames (PSNR/LPIPS on masked pixels), and the held-out camera with its real frame. Never claim accuracy without this comparison.

**PoC acceptance:**
1. Real pixels of the person, rendered in the room frame from a viewpoint that no source camera occupied, labelled RECONSTRUCTED.
2. Scrubbing gives the same frame for the same master time.
3. Clothing colours and body proportions are preserved.
4. Held-out or overlay error is reported.
5. All existing features are unchanged.

## G. Backup plan (always built; Mac only; ~3–4 h ⚪)

**Multiview matted video sprites.** For each camera that observes the person at time *t* (Phase 3 evidence):
1. Crop the real frame around the tracked person and matte it (SAM2 mask → RVM/BiRefNet alpha). Store an RGBA WebP sequence (≈3 cams × 15 fps × 3 s ≈ 135 small images).
2. In R3F, draw that crop on a plane through the tracked 3D position, **oriented toward its source camera, not toward the viewer**. From the source viewpoint it is pixel-exact.
3. Blend the two cameras whose viewing direction is closest to the virtual camera's, weighted by angle and by evidence state (an occluded camera gets weight 0).
4. Optional depth relief from Depth Anything V2 Small, scaled to the known foot depth, for real parallax.

**Properties:**
- Every displayed pixel is real footage (**OBSERVED** at source views, **RECONSTRUCTED** blend elsewhere).
- Honest failure modes: flat from side-on angles and no back surface, with ghosting during transitions shown as a fading cross-blend.
- It integrates with the master clock, the room occluder, X-ray (sprites hidden in X-ray; the humanoid shows through walls) and the evidence panel.
- It is visibly better than the mannequin while never inventing appearance.

## H. Next implementation prompt (do not run until P1/P2 and installs are approved)

> **Sentry4D — Phase 4: real-appearance subject from multiview footage.** Work in the existing repo. Do not modify camera poses, sync, room, or Phase 1–3 systems except as stated.
>
> 1. **Sync.** Set offsets to cam2 +0.394, cam3 +0.111, cam4 +9.567 through the existing store. Save to `src/config/camera-sync.json`. Run RE-PROJECT on annotations. Verify the three clap transients line up in the SYNC panel at master 4.99/5.61/6.35 s, and commit.
> 2. **Landmark calibration check.** Add a "Landmarks" tab to the Calibrate panel: click a point in the real frame, then click the same point on the room mesh (raycast in a split/top view). Store pairs in `src/data/calibration-landmarks.json`. Show per-camera median and max reprojection error with the current pose. Add `experiments/reconstruction/calibration/refine_pnp.py` (OpenCV: solvePnP + calibrateCamera, fixed principal point, k1/k2). It writes a *proposed* pose and distortion and reports before/after error. Only write `camera-poses.json` if median error improves and the user approves in the UI.
> 3. **Preprocessing** (`experiments/reconstruction/preprocess/`). `extract_clip.py` produces master-time-aligned 15 fps CFR SDR frames for a [t0, t1] window from the current offsets, recording the per-frame `(masterTime, videoTime)` mapping. `segment.py` runs SAM2 (MPS) with box prompts from `trajectory.sample(t)` projected into each camera, plus RVM alpha refinement, and writes RGBA crops + masks + `manifest.json`. Originals stay untouched; outputs are gitignored except `manifest.json`.
> 4. **Gate test.** `visual_hull.py`: carve a voxel hull from masks, compute leave-one-out IoU, write `gate_report.md`. Stop and report.
> 5. **App: `src/features/reconstruction/`.** Add `ReconstructionTypes.ts` (DynamicSubjectAsset as in REPORT §E), `ReconstructionLoader.ts` (manifest → preloaded textures keyed by frame index) and `DynamicHumanRenderer.tsx`. The renderer draws camera-oriented matted sprites at the trajectory position with view-dependent blending of the two best cameras (weights from viewing angle × evidence state), driven only by the master clock. Mount it beside SceneActors behind a "SUBJECT: AVATAR / FOOTAGE" toggle. Badge novel views "RECONSTRUCTED PERSPECTIVE". Hide sprites in X-ray (the humanoid handles X-ray). Fall back to the humanoid outside the clip window.
> 6. **Verify.** Viewed from each source camera, the sprite matches the real frame (overlay diff); a midpoint view shows real clothing; scrubbing is deterministic; build passes; existing features are unchanged.
> 7. **Optional cloud 4DGS** only with explicit approval: package `data/clip01` in COLMAP/4C4D format and the commands from REPORT §F.

## Measurements behind this report (reproducible)

- `preprocess/extract_audio.sh` → `audio_sync_gccphat.py`, `audio_transients.py`: sync offsets.
- `preprocess/stabilization_check.py`: CAM 01/03/04 static. CAM 02 sags 0 → ~12 px (1080p) between 5.5 and 34 s.
- `calibration/export_opencv.py` → `cameras_opencv.json`: K, R, t, COLMAP qvec/tvec. Matches the app's `worldToVideoPixel` to ≤0.0004 px; the self-test is built in.
- **Footage:**

| Camera | Codec | Range | Frame rate | Notes |
|---|---|---|---|---|
| CAM 01 | HEVC Main10 | HLG bt2020 | 29.89 fps VFR | 180° rotation flag |
| CAM 02 | H.264 | SDR | 29.99 fps | |
| CAM 03 | HEVC Main10 | HLG | 29.56 fps | |
| CAM 04 | HEVC Main10 | HLG | 29.66 fps | |

- **Per-camera intrinsics** (pinhole, from saved vFOV; distortion unknown):

| Camera | fx = fy (px) | hFOV |
|---|---|---|
| CAM 01 | 811.2 | 99.6° |
| CAM 02 | 850.9 | 96.9° |
| CAM 03 | 891.6 | 94.2° |
| CAM 04 | 1455.9 | 66.8° |

**Licensing for a commercial future:** Inria 3DGS rasterizer (non-commercial), SMPL (non-commercial), MASt3R (CC BY-NC-SA), RVM (GPL-3.0). Spark (MIT), gsplat (Apache-2.0), SAM2 (Apache-2.0) and DA-V2 Small (Apache-2.0) are clean.
