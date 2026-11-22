# Subject avatar: one articulated, clothed, textured 3D body from the four CCTV cameras

This folder turns the synchronized footage of a clip into **one** 3D model of the tracked person that is
valid for every frame: a skinned mesh with a baked animation in room coordinates
(`public/reconstruction/<clip>/avatar/subject-01.glb`) plus a small sidecar (`avatar.json`).
The viewer (`src/features/reconstruction/AvatarLayer.tsx`) plays it in two looks: **3D + FOOTAGE** (default), the
body carrying the real camera pixels of the shown instant, and **3D MODEL**, the body with its one baked texture.

## Why the person used to look like a blob

The previous renderer (`AppearanceLayer.tsx`, still available as **CUT-OUT**) is a billboard, not a
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
| 5b | `chair.py` | the chair he picks up and carries: a rigid proxy (dimensions fitted to the views in which it stands alone) and one 6-DoF pose per frame | `prop_chair.json`, `public/…/avatar/chair-01.glb` |
| 5c | `register.py` | per footage cut-out, the scale + shift that puts it on the fitted body, whether it is usable at all, and which pieces of the chair its matte shows (see "Footage on the body") | `register.json` |
| 5d | `rims.py` | the rim of a cut-out along furniture that hides the rest of the body gets the person's own colour instead of the furniture's (see "Footage on the body") | the cut-outs themselves (colours of the rim only), `rims.json` |
| 5e | `tone.py` | per footage cut-out and body part, how much lighter or darker that camera films the part at that moment than the baked texture holds it (see "Tone of the footage") | `tone.json` |
| 6 | `export.py` | skinned GLB (52 joints, ≤ 4 weights per vertex, one animation key per frame in room coordinates) + `avatar.json` (motion, cameras, registration, tone, chair poses) | `public/reconstruction/<clip>/avatar/` |
| 7 | `validate.py` | measures the exported GLB against every camera and frame | `metrics.json` |

Support files: `common.py` (paths, camera model identical to the app's), `body.py` (Anny rest state, own FK / linear
blend skinning that matches glTF exactly), `posefit.py` (pose parametrisation, joint limits, losses), `triangulate.py`,
`masks.py` (SAM 2 masks, which detections are on the visible person), `room.py` (scanned floor under the subject),
`render.py` (CPU rasteriser), `gltf_io.py` (GLB writer / reference reader), `chair_model.py` (the proxy: six convex
parts for the fits, 26 named pieces for the viewer, exact silhouettes, GLB with one mesh node per piece and the
slats cut by the texture's alpha), `chair_masks.py` (chair pixels by
background subtraction minus the fitted body, and what hides the chair), and the diagnostics `viz.py`, `silviz.py`,
`preview.py`, `chair_review.py`.

The body model is [Anny](https://github.com/naver/anny) (code Apache-2.0, MakeHuman-derived data CC0), with its
Mixamo-compatible rig. The 2D detector is RTMW-L through [rtmlib](https://github.com/Tau-J/rtmlib) (Apache-2.0).
Everything runs on CPU. For the 21 s clip on 4 cores: 2D keypoints about 10 min, then calibrate 40 s, fit 76 s,
shape 72 s (twice), refine 226 s, texture 250 s, export 3 s, validate 28 s; about 23 minutes in all. The chair adds
about 7 minutes, the registration 1 minute, the rims 40 s and the tone 20 s.

### Why the result cannot flicker or change identity

Shape, clothing offsets, UV layout and texture are single objects shared by all frames; only the 22 animated
joints and the root move. Playback sets the pose with `mixer.setTime(masterTime − t0)`, so a given master time
always shows exactly the same pose, whether you play, pause, scrub or step backwards.

Checked in the running viewer (headless Chromium, 176 seeks to 132 random master times, forwards and backwards):
wherever the subject is shown, the reconstructed body is what is drawn; its root joint is within 0.08 mm of the
exported motion for that time (the sidecar is rounded to 0.1 mm); and returning to a time gives the identical pose.

The 3D + FOOTAGE look draws the body in the pose of the frame whose cut-outs it carries (moved by the clock offset
of the cameras the viewer looks along, a fraction of a frame), so pose and pixels are always of one instant. While
the cut-outs of a frame are still loading, the last complete frame stays on screen with its own pose for up to 3
frames. Checked the same way (110 seeks to 82 master times, from one viewpoint): every seek ended on the clock's
frame, with the footage of each camera that has a usable cut-out of it and the root joint within 0.52 mm of the
exported motion around that frame, and the 28 times visited twice showed the identical pose of body and chair.
While playing (two stretches, 147 rendered frames, in a software renderer at about 1.4 frames per second) every
rendered frame carried the footage of its own frame. Playback at full speed on a GPU has not been measured.

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

## One colour for the four cameras (`texture.py`)

The four phones differ in exposure and white balance, so their pixels are brought to a common colour before they are
fused: one offset per camera and channel, estimated on the dark texels that at least three cameras saw, and no gain.
An earlier version fitted a gain and an offset per camera by regressing the other cameras on each camera. Both
sides of such a regression are noisy, so the fitted gains come out too small (regression dilution: cam2 got
0.80 x + 24 in blue), which lifts and tints the dark end: the joggers were teal on the lower legs, where cam2
contributes most, next to neutral footage on the thighs.

Measured on the 267,136 texels that all four cameras saw (each camera's mean over its views; 62 % of these texels
are dark, luminance under 40 of 255): the largest difference between the four cameras' medians on the dark texels is
6.9 / 3.9 / 6.2 levels (blue / green / red) without any correction, 20.4 / 9.5 / 3.6 with a gain and an offset fitted
that way on the same data, and 2.7 / 2.4 / 3.0 with the offsets (cam1 0 / +0.7 / 0, cam2 +4.1 / +1.9 / +3.5,
cam3 −1.1 / −1.7 / −3.6, cam4 −2.6 / −0.8 / 0). The offsets are fitted on the dark texels only: on the mid tones
(37 % of the texels) they are slightly worse than no correction (6.0 / 3.3 / 5.6 against 4.0 / 3.1 / 4.7), and the
bright 1.6 % (skin, the zip, the shoes) differ by 20 to 40 levels between cameras with or without a correction.

## Footage on the body (the viewer's 3D + FOOTAGE look)

One texture fused over 315 frames is complete but soft, and it cannot show what changes from frame to frame
(wrinkles, the hands, what he holds). The viewer therefore also projects the cut-outs of the **shown** frame back
onto the body (`src/features/reconstruction/hybridProjection.ts`): a point of the surface takes the pixel of every
camera that really sees it at that instant, cameras are weighted by how close they are to the viewing direction,
and points no camera sees keep the baked texture. From a camera's own position the subject is that camera's
footage; from anywhere else it is a solid body carrying the nearest real pixels. For that, `avatar.json` (version 2)
carries:

- `projection.cameras`: the refined cameras of step 2 (the app's own calibration is not accurate enough to put a
  pixel on the right limb), with each camera's clock offset `dt`;
- `projection.lift`: the height the viewer adds to the body per frame (see "The floor the viewer draws"), which
  has to be taken off again before projecting into a camera;
- `projection.known`: per cut-out, the rectangle of the frame in which its matte is authoritative (outside it the
  matte says nothing: the person may continue there);
- `projection.register` and `projection.use`: step 5c, below;
- `projection.tone`: step 5e, below: the 18 body `parts`, the part of each of the 52 skin `joints`, and per camera
  and frame 54 integers (18 parts × RGB, in units of `scale` = 0.001);
- `props`: the chair of step 5b: pose per frame, the names of its `pieces` (= the mesh nodes of its GLB), per
  camera and frame the pieces that camera's matte shows (`frames.cut`, one bit per piece; `frames.inMatte` is the
  older per-chair flag, used when `cut` is absent), and the pieces of one `plain` colour (its legs).

Which pixels a point takes depends on where the viewer stands:

- **At a camera** its cut-out lies over everything else as it is: whatever the viewer sees from there, the camera
  saw. It is a layer of its own, complete within 4.5° of the camera and gone at 11°, and under it is the blend of
  the next point. (It used to be a share of that blend. The camera the viewer looks along outweighs the others
  there a hundred times and more, so a pixel that fails the tests below stayed at full strength for as long as a
  trace of that share was left: 10° from cam1 at frame 60, a light jagged line of floor from the matte's rim ran
  down the outline of a leg.)
- **Away from a camera** a pixel has to be earned. The camera must really see the point (a depth map of the body
  rendered from that camera, and nothing within 3 px of an edge where one part of the body hides another), the
  pixel must lie 2 px inside the matte with body around it, it must look like the body there (the colour test of
  step 5e), and the camera must have seen the surface squarely enough. Next to the camera the cosine between the
  surface normal and the camera's ray may be as low as 0.45 (nothing below 0.12). For a viewer 35° or more from
  the camera the limits are 0.85 and 0.6: only what the camera saw within about 30° of square on is used in full,
  and nothing beyond 53°. A surface a camera saw at a slant lies within a few of its pixels of an outline (an arm
  is 16 px wide in clip02), where the pixel is as likely the chair or the wall beside it, and the viewer who now
  faces that surface sees every such pixel stretched. With the limits at 0.62 and 0.3 a row of light dashes ran
  along the left sleeve and pale streaks across the chest, 40° to 110° from cam1 at frame 244.

Within a few degrees of a camera the outline is the footage's own: slivers of the body that stick out of that
camera's matte are cut back to it. A part the matte lacks because furniture stood in front of it (the shins behind
a table, the legs behind the sofa) is not a sliver and must stay, or the body has a hole exactly where the furniture
was once the viewer stands closer than the furniture. The viewer tells the two apart by how much of the person around
a point the matte leaves out (a second, small render per camera: the person where the matte does not contain them,
read through its mipmaps; the person alone, because the chair he carries has its own per-piece flags): under 30 % it
is a sliver, over 45 % a hidden part.

Where a hidden part begins, the footage ends in the middle of the body, and two things would show as soon as the
viewer leaves the camera's exact position:

- **A line of the furniture across the body.** The matte's rim along the furniture is part furniture, and the
  footage is soft: the sofa's orange reaches about 6 px into the knee it hides. Two things keep it off the body.
  `rims.py` (step 5d) repaints that rim in the cut-outs: where the fitted body goes on beyond the matte, the outer
  pixels of the matte (and the invisible ones just outside, which texture filtering reads) take the person's colour
  from 7 px further in. Hands, head, feet and thin parts are left as filmed, the mattes are not changed, and on
  clip02 it touches 589 of the 1077 cut-outs, a few hundred pixels each. And the viewer does not project the last
  4 px of the matte where a hidden part begins (the rule sets in at a hidden share of 24 % and is complete at 36 %).
- **A ledge.** The outline card is a little wider than the body, so where the matte ends and the body goes on it
  would end in a step. The card fades out between 8 % and 35 % of hidden person around a point (over a
  neighbourhood three times as wide as the one above) and drops the same rim.

What remains is the step from footage to the part below it, which comes from another camera or the baked texture:
it is softer and can be a little wider (see Limits).

### Registration of the cut-outs (`register.py`)

The body is fitted to all four cameras at once, and where they agree it lands on each cut-out to a few pixels
(table below). Where one camera's model is weakest it does not: with the person one to two metres from the
wide-angle lens of cam1 (frames 13–62 and 273–311) the footage is up to 20 % smaller than the projected body and
shifted towards the image centre, by more than 100 px in the worst frames (unmodelled lens distortion at the edge
of the frame); cam4 is off by up to 37 px while he enters and leaves its frame. Footage projected onto the body then lands on the wrong part of it.

For every cut-out, `register.py` finds the similarity `p_footage = c + s (p_body − c) + d` that maximises the IoU of
the projected body (plus the chair, when the matte contains it) with the matte inside the known rectangle. The
search is exhaustive (IoU for every shift within ±240 px from two FFT cross-correlations, scales 0.7–1.3), a scale
is only believed when the result reaches IoU 0.8, the identity is kept unless the gain is clear (≥ 0.03 IoU and
≥ 6 px), and the result is median-filtered over time. A view that still disagrees with the body, or shows less than
a quarter of it, is switched off (`use` false). The viewer moves the cut-out, never the body.

On clip02 (1077 cut-outs): 128 are moved (cam1 95, cam2 16, cam4 17), 17 are not used (cam1 13–14 and 304–311,
cam2 108–111, cam4 99–100 and 252). The silhouette IoU of the 85 moved cam1 views that are used goes from a median
of 0.81 (worst 0.39) to 0.92 (worst 0.80); cam4's 14 from 0.79 (0.60) to 0.88 (0.81).

### Tone of the footage (`tone.py`)

The baked texture holds one colour per point of the body for the whole clip. A camera films that point lighter or
darker at a given moment: the back of the hoodie under the ceiling lights while he bends over the table, haze at a
distance, the camera's exposure. The viewer needs that difference for two things:

- **Which pixels belong on the body.** Away from a camera a footage pixel is only put on a point of the surface if
  it looks like the body there (it may be a wall seen through a gap in the matte, or the chair in front of him).
  Compared with the texture as baked, a hoodie filmed much lighter fails that test, and the lit back fell back to
  the dark texture in patches.
- **What the fill looks like beside footage.** The parts no camera shows are the baked texture; in its own tone it
  stands out as a dark patch next to lit footage.

The difference is not one number per view (camera 1 films the back 0.2 lighter than the texture while he bends
over the table at frame 150, and his trousers 0.01 to 0.06 lighter), so `tone.py` measures it per cut-out and
**body part** (18 parts: the bones of the rig, fingers and toes counted to hand and foot). The body with its baked
texture is rendered into the camera, moved by the registration of step 5c, and over the pixels that both the matte
and the body cover (2 px inside both, without a carried object) the median of

    sqrt(linear footage) − sqrt(linear baked)

is taken per part and colour channel (the gamma 2 encoding the viewer's shader compares colours in). The fewer
pixels a view has of a part, the more the part takes the value of its garment (top, bottom, skin, shoes) and of the
whole body: with 60 pixels it is half its own median, under 20 it is its garment's alone. Per camera and part the
series is then smoothed over time (median of 7 frames, then mean of 7) and limited to −0.15 … +0.32.

On clip02 all 1077 cut-outs are measured. Mean over RGB, median over the views and the parts of the row (5th to
95th percentile):

| | cam1 | cam2 | cam3 | cam4 |
|---|---|---|---|---|
| torso (three spine parts) | +0.055 (−0.038 to +0.256) | +0.028 (−0.065 to +0.148) | +0.022 (−0.041 to +0.077) | −0.004 (−0.054 to +0.079) |
| legs (thighs and shins) | +0.017 (−0.041 to +0.060) | −0.014 (−0.039 to +0.015) | +0.010 (−0.011 to +0.041) | +0.006 (−0.012 to +0.041) |

From one frame to the next the part that changes most changes by 0.007 to 0.009 in the median (largest step in the
clip 0.029, about 4 levels of 255 on a dark hoodie), so the tone does not flicker.

In the viewer (`hybridProjection.ts`) the offsets live in a small texture with one texel per bone and camera; every
vertex takes the tone of the bones that move it (its skin weights). It is used in three places:

1. **The colour test.** A camera's pixel is compared with the baked colour of the point plus that camera's tone for
   the part. Brightness is compared on the mean of the pixel and four pixels 4 px around it, so a thin detail the
   texture lacks (a drawstring, a seam) passes and a patch of something else does not. Hue (the largest channel
   difference once the brightness difference is taken out) is compared on the pixel itself: the light on the body
   changes from moment to moment, its hue does not. Within 6 px of the matte's rim the hue limits are 0.3 times
   as wide, because the rim is part background and video compression smears colour across the edge (on clip02 the
   orange wall tints the grey hoodie up to 4 px inside the matte).
2. **One tone for the picture.** Footage and fill are mixed in the texture's tone (every pixel minus its camera's
   tone). The result then takes the tone of the cameras, each counted by how close it is to the viewing direction
   (1/e at 30°) plus a tenth for seeing the surface squarely, so a lit back stays lit from the side, the fill
   beside a camera's pixels has their tone, and the pixels of two cameras meet in one tone. At a camera the tone is
   that camera's alone: its pixels are the recorded ones again, unchanged.
3. **Not on objects.** The chair has no tone (it is measured on the person); its legs use the colour test against
   their own plain colour (below).

Between two cameras the picture used to be a double exposure of both. Of two cameras far from the viewing direction
the nearer one now counts more: the weight a camera gets for seeing the surface squarely is halved 25° from the
viewing direction and falls with the fourth power of the angle beyond, down to 3 % of itself.

### The chair (`chair.py`)

He rests a hand on a café chair at frame 162, pulls it, lifts it at frame 220 and carries it out in both hands from
frame 234. `chair.py` reconstructs it as one rigid object: a proxy of six convex pieces (seat 0.44 × 0.41 m at
0.45 m, backrest to 0.84 m tilted back 10°, four splayed legs; all nine dimensions fitted to the views in which the
chair stands alone) and a 6-DoF pose per frame, fitted to the chair pixels of all cameras (background subtraction
minus the fitted body) with the palms kept on the chair, the chair kept out of the body and above the floor. While
it is carried the pose is rigid in the frame of the two hands plus a bounded per-frame correction from the images.

Measured against the chair masks (median distance of the proxy outline from the mask outline; IoU): standing
1.0 / 1.4 px in cam1 / cam2 (IoU 0.48), carried 3.0 / 4.0 / 2.2 / 4.1 px in cam1–cam4 (IoU 0.40 / 0.45 / 0.53 /
0.74), picked up 3.0–9.0 px. The IoU is low for a good outline because the thin legs are mostly missing from the
masks and a 2 cm leg that is 2 px off scores no overlap. By eye the orientation agrees with the footage to within
about 8° and the position to 2–3 cm. Frames 296–314 are the least certain (he tips the chair as he reaches the door, and from frame
306 no camera sees it from the front). The room scan contains no chair, so the proxy is the only one in the scene.

**Which pieces a matte shows.** SAM 2 follows the seat and the backrest; the 2 cm legs come and go from frame to
frame. Cutting the whole chair to a matte that lacks two legs removes those legs, and next to that camera the chair
then floats on two. So the chair is judged piece by piece (seat, backrest, each leg in six segments from the seat
down: 26 pieces): `register.py` projects every piece into the matte and calls it shown when, along at least half of
the part of it that is clear of the person (for a leg: also clear of the seat and backrest), there is matte within
5 cm (4 to 14 px) that the person does not explain. A piece that is mostly in front of or behind the person is not
judged and keeps the matte's outline. Next to a camera the viewer cuts the shown pieces to the matte (real pixels)
and draws the others as the grey proxy, so a leg is always there. A piece a matte lacks takes no pixels from that
camera from any angle: what the matte holds where the piece would be is the person or another piece. Nothing is
smoothed over time: every frame follows its own matte, so a leg can change between footage and proxy from one frame
to the next, as it does in the mattes.

**Colours of the proxy.** They are measured on the close views of the carried chair, as a high percentile of the
chair pixels inside the outlines of the pieces: the 85th for the slatted panels (RGB 160, 165, 166), which is the
lit surface (the rest is slat shadow and what shows through the gaps), and the 95th for the legs (159, 160, 150).
A leg is a 2 cm tube a few pixels wide, so most of its pixels are mixed with what is behind it, and their 85th
percentile (143, 138, 134) is a darker grey than any leg looks in the footage. The GLB's texture is opaque between
its tiles and continues the colour of the tile next to it: a leg a few pixels wide on screen is drawn from a small
mip level, which mixes its narrow tile with its surroundings, and black, transparent texels there made the legs
dark and thin.

**Finish of the proxy.** The chair is silver metal with a slight gloss, and one flat grey reads as matte plastic.
`chair_model.py` therefore writes, next to the colour, what a renderer needs to light it as metal: metallic 1.0 and
roughness 0.45; a tangent-space normal map on the same tiles as the colour (a slat is rounded at its edges, 50° over
3.5 texels of 1.8 mm, and crowned by 11° across its width, so a highlight runs along every slat); and a second
normal per vertex, `_SHADE_NORMAL`, for shading only: on a leg it points straight out from the axis (the leg is a
square bar in the geometry and a round tube in the light), on the two large faces of a panel it leans 6° outwards
towards each side (a pressed sheet is never dead flat, and without that a panel mirrors one direction and is one
flat tone again). The geometry and its `NORMAL`s stay the flat boxes that were fitted to the footage.

The viewer does not use scene lights for the subject (its colours are measured from footage), so the gloss is
computed in `AvatarLayer.tsx` (`METAL_FINISH_GLSL`) for any prop material with metallic ≥ 0.5: the shading normal
mirrors the viewing direction into a small model of this room (darker floor below, lit ceiling above with a soft
horizon, daylight from the side of the glass wall, three soft highlights for the rows of ceiling lights whose width
follows the roughness, a faint rim at grazing angles) and the result scales the measured grey between about 0.75 and
1.35 plus the highlights (`METAL_TUNING`). It is applied to the proxy's own colour only: pixels of the footage that
land on the chair already carry the real reflections and are left as they are, so the camera views are unchanged.
The strengths are set by eye against the recording ("a little bit glossy"), not measured from it; there is no
reflectance estimate of the chair. Checked at 20.5 s from CAM 01's own position: against the picture before this
change only the grey proxy legs and the animated markers (ground ring, camera dot) differ; the person and the footage on
the chair are identical.

**Wireframe.** In the room's wireframe view a solid chair would be the only solid piece of furniture. The GLB
carries a second scene, `wireframe`, with one mesh `wire` made for line drawing (651 vertices, 804 triangles): each
panel as a single sheet with the gaps between its slats left open, each leg as a four-sided tube, cells at most
4.5 cm long. The viewer draws it with the room's wire material whenever the room is in wireframe, with stronger
lines than the room (opacity 0.75 against 0.3: at the room's strength a chair of this size disappears among the
lines of the table and floor behind it) and with its faces written to the depth buffer only, so the lines of the
room behind the chair do not show through it. The person stays as he is. Footage of the chair is then kept off
him: the layer of a camera whose matte contains the chair keeps only the pixels that camera saw of the body, and
the cards leave out matte pixels that lie around an object in the depth map. Out of wireframe nothing changes.

**Which pixels go on the legs.** Away from a camera the legs (the prop's `plain` pieces: one plain colour) take only
those of its pixels that look like that colour, by the colour test of "Tone of the footage": a leg is a few pixels
wide and the pose of a carried chair is known to 2 to 3 cm, so some of the pixels that land on it are the trousers
behind it. The panels take the pixels of their matte as they are: slats show what is behind them through the gaps,
and their baked colour is one grey.

On clip02 the mattes with the chair show: cam1 (139 mattes) seat 100 %, backrest 99 %, legs 60 to 90 %; cam2 (68)
seat 74 %, backrest 90 %, legs 32 to 99 %; cam3 (15) seat 93 %, backrest 67 %, legs 30 to 61 %; cam4 (25) every
piece 98 to 100 % (per leg: mean over its six segments). Mattes that lack at least one piece: cam1 106 of 139,
cam2 62 of 68, cam3 15 of 15, cam4 3 of 25.

### Cut-outs added and repaired (`../segmentation/fill_missing_crops.py`)

The first export had cut-outs for 966 of the camera views. For the footage look, 111 missing views were added
(the person close to cam1, entering cam4, behind the plant in cam2) and 222 were replaced, mostly so that the
matte contains the person **and** the chair he holds instead of half of it (SAM 2.1 video propagation seeded with
the neighbouring mattes; the maskMethod of every such entry says so, and `…+carried:chair` marks the mattes that
contain the chair). The script never runs `export_sprites.py`, which deletes the clip's folder.

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
$PY chair.py     --clip clip02            # clip02 only: the chair he carries (defaults are for this clip)
$PY register.py  --clip clip02            # after any change to the cut-outs, the fit or the chair
$PY rims.py      --clip clip02            # after register.py; rewrites rim colours in the cut-outs (--restore undoes it)
$PY tone.py      --clip clip02            # after rims.py: it measures the cut-outs as the viewer gets them
$PY export.py    --clip clip02
$PY validate.py  --clip clip02 --sheet /tmp/avatar_check.jpg
$PY export.py    --clip clip02            # again, to embed metrics.json in avatar.json
```

Diagnostics: `preview.py --frame 170 --out x.jpg` (turntable of any frame, `-1` = rest pose),
`silviz.py --frames 60,150,200 --out x.jpg` (mask outline in green, model outline in red, per camera),
`chair.py --review DIR` (the proxy over the footage of every camera),
`register.py --only "cam1:13-30;cam4:99-110"` (per-view numbers for some views, writes nothing),
`rims.py --only cam3:244,cam2:60 --out DIR` (per view: the body beyond the matte, the rim that is repainted,
before and after; writes no cut-out).
`refine.py --w-anchor 0 --w-steady 0` shows what the silhouettes do when nothing holds them back.

## Results on clip02 (4.2 s – 25.2 s, 315 frames, 1077 camera views)

Every number is measured on the exported GLB (evaluated the way a glTF viewer does), against the footage. The body
was fitted to the 966 cut-outs of the first export; it is measured here against all 1077 of the current ones
(`validate.py` after step 5d):

| | cam1 | cam2 | cam3 | cam4 |
|---|---|---|---|---|
| views with a SAM 2 mask | 299 | 309 | 315 | 154 |
| 2D keypoint error, median (px) | 3.1 | 3.2 | 2.4 | 4.1 |
| the same on the subject, median / p90 (cm) | 2.4 / 5.4 | 2.1 / 5.1 | 2.0 / 4.7 | 1.4 / 4.4 |
| confident detections discarded (not on the visible person) | 110 | 1067 | 604 | 503 |
| confident detections the keypoint-only fit explains, lost by the delivered body | 1 | 4 | 0 | 1 |
| of these without a carried object (the three silhouette rows) | 124 | 241 | 298 | 129 |
| silhouette IoU, median (p10) | 0.88 (0.61) | 0.79 (0.57) | 0.86 (0.50) | 0.83 (0.74) |
| mask covered by the body (recall), median | 0.96 | 0.96 | 0.94 | 0.97 |
| body inside the mask (precision), median | 0.92 | 0.84 | 0.95 | 0.86 |
| re-rendered texture vs footage, mean abs. error (0-255) / PSNR | 20.14 / 18.05 dB | 22.23 / 17.17 dB | 19.04 / 18.78 dB | 18.15 / 18.91 dB |

- **Asset**: 1.18 MB GLB, 14,898 vertices, 27,420 triangles, 315 animation keys; read back like a viewer does, it reproduces the fitted surface to 0.0018 mm.
- **One body for all frames**: identical topology, UVs and texture; bone lengths change by 0.0005 mm over the clip. Stature 1.79 m (1.83 m with shoes and hair).
- **Detections kept**: 13,632 confident detections are explained within 1 sigma by the keypoint-only fit; the delivered body (after silhouettes and ground contact) misses 6 of them by more than 2 sigma (nose 4, leftEye 1, rightEye 1: face keypoints in views that see the back or the side of the head, which the silhouette stage discounts on purpose). Median residual 0.53 sigma before, 0.59 sigma after.
- **Evidence per frame** (cameras with a usable detection of the body, the count the viewer shows as "fitted from N cameras"): 4 cameras in 140 frames, 3 in 93, 2 in 72, 1 in 8, none in 2.
- **Joint limits**: ankle outside its range in 0 frames; thigh twist at most 54 deg (limit 60, exceeded in 0 frames); joint changes faster than a person can move: 0 (fastest 0.94 x the limit). Joint rotation per frame: median 1.9 deg, p99 19.1, max 33.7.
- **Ground** (scanned room floor (height map)): lowest point of the body -1.6 mm (worst frame) / -0.3 mm (median) relative to the floor, 0 frames more than 5 mm below it; a foot is planted in 99 % of the frames (70 intervals) and moves 0.32 mm per frame while planted (p90 0.89, max 14.05); before the contact stage it crept 3.86 mm per frame.
- **Coverage**: 80 % of the surface was seen by at least one camera at some time (92 % of the atlas texels in two or more of the 1077 views, median 159 views per texel).
- **Shake**: frame-to-frame zig-zag of the joints (RMS distance from a local cubic over 5 frames): pelvis 1.7 mm,
  hips 1.8 / 1.9 mm, wrists 5.1 / 4.1 mm, ankles 6.5 / 6.7 mm. The keypoint-only fit has 1.8 mm, 1.8 / 1.9 mm,
  5.5 / 4.3 mm and 5.9 / 5.3 mm; before the *anchor* and *steady* rules and the decaying step, the silhouette stage
  left 4.0 mm in the pelvis and 12.1 / 8.8 mm in the wrists.

How to read these numbers:

- The keypoint error is agreement with a 2D detector, not with ground truth. The keypoint-only fit, which
  optimises nothing else, reaches 2.8 / 2.9 / 2.2 / 3.8 px; the delivered body gives up 0.2 to 0.4 px of that for
  silhouettes and floor contact.
- The silhouette statistics leave out the views whose mask is flagged as containing a carried object. What holds
  them down is furniture: the body is drawn whole, the mask stops at the sofa or the table (precision; for cam3
  the IoU is 0.48 to 0.69 in frames 119–231, while he stands behind the sofa), and some unflagged masks still
  contain the chair.
- They compare the body where the calibrated cameras put it, before the registration of step 5c. The low end of
  cam1 are the views added later with the person one to two metres from its lens (frames 13–27: IoU 0.13 to 0.70)
  and leaving its frame (310–311); on the 109 such views of the first export cam1 had 0.90 (0.84).
- The photometric numbers compare one fused texture with four cameras that differ in exposure and white balance,
  over every view, including those whose mask is flagged as containing a carried object (175 of cam1's 299).
  The cut-outs they are compared with have the rims of step 5d repainted; with the rims as filmed the mean
  absolute errors are 20.14, 22.41, 19.21 and 18.18.
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
- colour of every surface that at least one camera saw at some point in the clip (80 % of the surface).

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

The viewer labels the 3D MODEL look **RECONSTRUCTED 3D BODY**. The 3D + FOOTAGE look is labelled **OBSERVED VIEW**
within 6° of a camera and **3D BODY + FOOTAGE** elsewhere, with the cameras that contribute real pixels at that
instant; **CUT-OUT** shows one camera's cut-out, which is that camera's pixels except for the rims repainted by
step 5d (the clip's `manifest.json` says so in its note).

## Limits and upgrade paths

- **"100 % accuracy" is not attainable from four phone cameras** for surfaces they never saw, and the numbers above
  are agreement with the footage, not ground truth: there is no scan of the person to compare against.
- **Carried objects**: the chair is a rigid proxy with an approximate pose (see "The chair"); the laptop is not
  modelled. Both are kept out of the body's texture by building the starting colour consensus from the frames before
  anything is picked up, and out of the pose by the anchor / near rules above. From a camera's own position the
  seat, the back and the legs that camera's matte holds are the recorded ones. The legs the matte lacks (thin, light
  grey on a light floor, and in cam1 a second chair of the same colour behind them) are the grey proxy, which the
  approximate pose puts a few pixels off: from cam1's position at frames 243 to 252 (20.4 s to 21.0 s) the two legs
  on the right of the picture are separate grey bars below the seat, dashed in places and shorter than the recorded
  legs, and at frame 282 (23.0 s) the long leg on the left ends half-way with fragments below it; from frame 253 to
  281 the chair there follows the recording, with a small stray leg fragment beside it at frames 259 to 263. A few
  degrees away the proxy legs stand a little apart from the seat as well (frames 244 to 247, 8° to 10° from cam1 and
  cam3). From the side while he carries it in front of him (frame 256, 45° from cam2) the legs are fragments, and
  the part of the chest the chair hid from the nearest camera is a lighter patch with a sharp edge. The gaps between
  the slats show what the camera saw through them (the orange wall), also from a side where something else is behind
  the chair.
- **Footage on the body is only as sharp as the footage**: the head is 30–40 px wide, and what lies outside a
  camera's frame (the legs when he is close to cam1 or cam4) or behind furniture is the baked texture. Away from
  the camera angles the pixels sit on a body that is a few centimetres off the real surface, so fine detail
  (zip, drawstrings, fingers) smears; within 5° of a camera the outline is the footage's own.
- **Where footage meets the model there is a step.** A part that one camera does not show (legs behind the sofa
  or the table, or below its frame) comes from another camera or the baked texture, and is softer and a little
  wider or narrower than the footage above it. On clip02 the plainest case is a light sliver at knee height, between
  the thigh (footage) and the shin (model), 10° from cam3 at frame 244.
- **Between two cameras the hand-over shows.** The pixels of two cameras meet in one tone, but not in one sharpness
  or one registration: at frame 150, 20° to 30° from cam1, a vertical seam runs down the back where they meet.
- **The face holds only at a camera.** From about 6° off a camera the head is the tested blend, and where that
  camera saw the head at a slant (under the jaw, the far cheek) the model's own face shows, which is a blurred
  average with a darker chin: at frame 100, 7° to 20° from cam3, a dark arc lies under the chin. At 20° from cam1
  at frame 250 the face is blurred.
- **Leaving a camera, 5° to 12° away**, the slivers of the body outside that camera's matte fade in and are half
  transparent in between, and that camera's own cut-out fades out over the tested blend.
- **A matte that contains something else paints it on the body.** At frame 60 the bottles on the table in front of
  his legs are inside cam2's matte and lie on his legs as white spots 7° and 10° from cam2 (from cam2 itself they
  are where the bottles stand). Beyond 11° the colour test applies and they shrink, but the smallest are kept as
  it keeps a zip or a logo, and are still there at 19°. At frame 200, 10° from cam2, a green-yellow patch of the
  plant lies on his side; at 14° the hue test has reduced it to a trace. Cam2's mattes behind the plant (frames
  237–246) are fragments.
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
