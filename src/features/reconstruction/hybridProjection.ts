/**
 * FOOTAGE ON MODEL renderer core: the real camera pixels of the shown frame on the reconstructed 3D body.
 *
 * The 3D MODEL look paints the body with ONE texture fused over the whole clip: complete, but soft.
 * The FOOTAGE look shows one camera's pixels: sharp, but a cut-out with no sides. This combines the
 * two the way image-based rendering does (view-dependent projective texturing):
 *
 *   surface  the reconstructed body (and the objects it handles) in the pose of the shown frame
 *   colour   every fragment is projected into the camera frames of that instant with the calibration
 *            the body was fitted with. Where a camera really sees that point (inside its matte, in
 *            front in a depth map of the body rendered from that camera, not at a grazing angle) its
 *            pixel is used. Cameras are mixed by how close they are to the viewing direction, so the
 *            camera you look along wins and the hand-over between two cameras is continuous.
 *   at a     the cut-out of the camera the viewer stands at lies over that blend as it is, untested, and
 *   camera   fades out as the viewer leaves (own0, own1): there the camera saw what the viewer sees
 *   fill     points no camera sees at that instant keep the baked texture of the 3D model
 *   tone     a camera films a part of the body lighter or darker than the baked texture holds it (the back
 *            of someone bending over under the ceiling lights, haze at a distance, exposure). The exporter
 *            measures that per cut-out and body part (avatar/tone.py). Footage and fill are mixed in the
 *            texture's tone, and the picture then takes the tone of the cameras by how close they are to the
 *            viewing direction and how squarely they see the surface: the fill beside a camera's pixels has
 *            their tone instead of standing out dark, and the pixels of two cameras meet in one tone
 *   outline  within a few degrees of a camera the silhouette is the footage's own: slivers of the body
 *            outside that camera's matte are cut away, and matte pixels the mesh does not cover (hair,
 *            loose cloth, things on the table) are drawn on a card that follows the surface depth.
 *            Both fade out as the view leaves the camera, where the mesh outline takes over. A part the
 *            matte lacks because furniture stood in front of it is not a sliver: it stays, drawn from the
 *            other cameras or the baked texture, and the card stops short of it so that the footage
 *            outline does not end in a ledge where the furniture's edge was.
 *
 *   finish   the fill of an object can have a look of its own on top of its baked texture (the sheen of a metal
 *            chair, HybridFinish). It is put on the fill only, after every test that compares a camera's pixel
 *            with the baked colour, so what the footage covers and which pixels it takes do not depend on it
 *   see-     an object drawn as a wireframe (the room's wireframe view) no longer covers the person. A camera's
 *   through  cut-out that contains that object still does: its layer over the blend then keeps only the pixels
 *            that camera saw of the person, and every card leaves out what lies around the object (setSeeThrough)
 *
 * Seen from a camera's own position the subject is therefore that camera's cut-out pixel for pixel
 * (the exporter repaints the cut-out's rim along furniture with the person's own colour, avatar/rims.py);
 * anywhere else it is a solid body carrying the nearest real pixels.
 *
 * Registration: where a camera's calibration is weak (the person close to a wide-angle lens, or at the
 * edge of its frame) its cut-out and the fitted body are tens of pixels apart. The exporter measures, per
 * cut-out, the scale + shift that puts the cut-out back on the body (avatar.json `projection.register`);
 * here the cut-out's rectangle is moved by it, so every lookup below already works in the body's pixels.
 *
 * Coordinates: the cameras see the body in FIT coordinates; the viewer draws it `lift` (a few cm)
 * higher so it stands on the scanned floor. Everything here converts with X_fit = X_world - (0, lift, 0).
 */
import * as THREE from "three";
import { CAMERA_IDS, type CameraId } from "../../types/security";
import type { AvatarProjection } from "./ReconstructionTypes";

/** Camera slots of the shaders (unused ones stay switched off). */
const SLOTS = 4;
/** Depth map of the body per camera: covers that camera's crop, so about 1-2.5 texels per footage pixel. */
const DEPTH_W = 512;
const DEPTH_H = 1024;
/** Per camera, at a quarter of the depth map's texels: how much of the body its matte leaves out (see SHARE_FRAG). */
const SHARE_W = 256;
const SHARE_H = 512;
/** Depth window (m) around the pelvis encoded in 16 bits (0.05 mm steps). */
const DEPTH_RANGE_M = 3.2;
const DEG = Math.PI / 180;

/** Look of the blend. Angles in radians, lengths in metres unless noted. */
export const HYBRID_TUNING = {
  /** Width of the view preference: a camera this far from the viewing direction has weight 1/e. */
  viewSigma: 10 * DEG,
  /** Footage outline (trim + fringe card) fully on inside `near0` of a camera, gone beyond `near1`. */
  near0: 5 * DEG,
  near1: 12 * DEG,
  /** Inside `own0` of a camera its cut-out is laid over the blend as it is (no visibility / facing test); gone beyond `own1`. */
  own0: 4.5 * DEG,
  own1: 11 * DEG,
  /** Weight of a well-facing camera far from the viewing direction (keeps real pixels on the sides). */
  farFloor: 0.02,
  /**
   * Of two cameras far from the viewing direction the nearer one counts more, or the picture between two cameras
   * is a double exposure of both: that weight is halved for a camera `farTau` away and falls with the fourth
   * power of the angle beyond, down to `farMin` of itself.
   */
  farTau: 25 * DEG,
  farMin: 0.03,
  /** cos(angle between surface normal and camera ray) below which a camera is not trusted / fully trusted, next to that camera. */
  facing0: 0.12,
  facing1: 0.45,
  /**
   * The same limits for a viewer `farAngle` or more away from the camera (in between they are interpolated).
   * A surface the camera saw at a slant lies within a few of its pixels of an outline (an arm is 16 px wide in
   * clip02), where the pixel is as likely the chair or the wall next to it, and the viewer who now faces that
   * surface sees every such pixel stretched: only what the camera saw within about 30° of square on is used in full.
   */
  farAngle: 35 * DEG,
  farFacing0: 0.6,
  farFacing1: 0.85,
  /** Footage pixels around an occluding edge that are not projected onto what lies behind it. */
  guardPx: 3,
  /** Depth test tolerance. */
  bias: 0.012,
  /** Away from a camera, its pixels closer than this to the rim of its matte are not projected (they are part background). */
  erodePx: 2,
  /**
   * Size (fraction of the crop height) of the slivers of the body that are cut back to a camera's matte.
   * What sticks out further is a part hidden from that camera, not a misplaced one, and stays.
   */
  reach: 0.05,
  /**
   * Away from a camera, a pixel is dropped when it looks unlike the body's own (clip-wide) colour at that point,
   * in the tone that camera films that part of the body in (gamma-encoded colours).
   * Brightness: mean channel difference, fully kept below `alike0`, dropped above `alike1`. Measured on the mean of
   * the pixel and four around it, `alikePx` away, so that a thin detail the baked texture lacks (a drawstring, a
   * seam, a logo) is kept and a patch of something else is not.
   * Hue: largest channel difference once the brightness difference is taken out, kept below `hue0`, dropped above
   * `hue1`. Measured on the pixel itself: the light on the body changes from moment to moment, its hue does not, so
   * a wall seen through a gap in the matte, or mixed into the matte's rim, is told by its hue.
   */
  alike0: 0.22,
  alike1: 0.42,
  hue0: 0.1,
  hue1: 0.22,
  alikePx: 4,
  /**
   * The rim of a matte is part background: the matte is a pixel or two wide of the person, and video compression
   * smears colour across the edge (measured on clip02: an orange wall tints a grey hoodie up to 4 px inside the
   * matte, where `erodePx` no longer reaches). Within `rimPx` of the matte's edge the hue limits above are
   * therefore `rimHue` times as wide.
   */
  rimPx: 6,
  rimHue: 0.3,
  /**
   * Tone of the picture (see `tone` above): a camera this far from the viewing direction counts 1/e, and a camera
   * that sees the surface squarely counts `toneFacing` wherever the viewer is (the lit back stays lit from the side).
   */
  toneSigma: 30 * DEG,
  toneFacing: 0.1,
  /** Away from a camera, share of body around a point (as that camera sees it) below which / above which its pixel is used. */
  inside0: 0.6,
  inside1: 0.95,
  /** The fringe card sits this far behind the surface depth, as seen from its camera. */
  fringeBack: 0.03,
  /** Where the frame edge cuts the person, that camera's pixels fade out over this many pixels before it (no hard seam across the body). */
  edgePx: 40,
  /**
   * Share of the body around a point that a camera's matte leaves out: below `hidden0` what sticks out of the
   * matte there is a sliver of the model (cut back to the matte), above `hidden1` it is a part furniture hid
   * from that camera (kept). Measured over a neighbourhood `hiddenReach` times `reach` wide.
   */
  hidden0: 0.3,
  hidden1: 0.45,
  hiddenReach: 2,
  /** Next to a camera, its pixels this close to the rim of the matte along such a hidden part are not used (they are part furniture). */
  hiddenRimPx: 4,
  /**
   * The outline card of a camera stops short of a part of the person that furniture hid from it: the footage outline is
   * a little wider than the model's, and where the matte ends at the furniture it would end in a ledge with the model's
   * outline going on below it. Where the card borders the person it fades out between these two shares of hidden body
   * around a point, measured over a neighbourhood `outlineHiddenReach` times `reach` wide.
   */
  outlineHidden0: 0.08,
  outlineHidden1: 0.35,
  outlineHiddenReach: 6,
};

/** One camera's cut-out of the shown frame. */
export interface HybridCrop {
  texture: THREE.Texture;
  /** Crop rectangle in frame pixels [x0, y0, x1, y1]. */
  rect: readonly number[];
  /** Rectangle in which the matte is authoritative (null: the whole frame). */
  known: readonly number[] | null;
  /** Where the cut-out belongs on the fitted body: body pixel = a * footage pixel + (bx, by) as [a, bx, by]; null: as filmed. */
  register?: readonly number[] | null;
  /**
   * What this footage adds to the body's baked colour: per body part [r, g, b] of the gamma-encoded colours, flat,
   * in units of AvatarProjection.tone.scale; null: nothing.
   */
  tone?: readonly number[] | null;
}

/** Per-object uniforms of a hybrid surface. */
export interface HybridOwn {
  /** Height (m) this object is displayed above its fit position. */
  uHyLift: { value: number };
  /**
   * Per camera slot: what that camera's matte is to this object.
   * 0 its outline does not follow the matte (the matte does not contain it), 1 slivers only (the body: parts hidden
   * from the camera stay), 2 cut to the matte next to the camera (a carried object the matte contains),
   * -1 the matte contains the object but not this piece of it: none of that camera's pixels belong on it.
   */
  uHyTrimOn: { value: THREE.Vector4 };
  /**
   * How strictly a pixel must look like the object before it is projected onto it away from its camera:
   * 1 the person, 0 no test (an object whose baked colour is a rough guess).
   */
  uHyAlike: { value: number };
}

/**
 * A look of the fill beyond its baked texture (a metal object's sheen). The GLSL of `fill` acts on `hyFill`
 * (vec3, linear: the baked look of this fragment) with `hyN` (unit normal, towards the viewer) and `hyV` (unit
 * vector to the viewer) in scope, and may use the varyings vAvatarN, vAvatarP and whatever the pars declare.
 */
export interface HybridFinish {
  /** Names the shader variant (materials with the same key share a program). */
  key: string;
  uniforms: Record<string, THREE.IUniform>;
  vertexPars: string;
  /** After the world position and normal are known. */
  vertexMain: string;
  fragmentPars: string;
  fill: string;
}

/** World normal and position, and per camera slot the tone of that camera's footage at this point of the body. */
const SURFACE_VARYINGS = /* glsl */ `
varying vec3 vAvatarN;
varying vec3 vAvatarP;
varying vec3 vHyTone0;
varying vec3 vHyTone1;
varying vec3 vHyTone2;
varying vec3 vHyTone3;`;

/** The tone of a vertex is that of the body parts its bones belong to (uHyToneTex: one texel per bone and camera slot). */
const SURFACE_VERT_PARS = /* glsl */ `
#ifdef USE_SKINNING
uniform highp sampler2D uHyToneTex;
vec3 hyToneOf( int slot ) {
  vec4 w = skinWeight / max( skinWeight.x + skinWeight.y + skinWeight.z + skinWeight.w, 1e-4 );
  ivec4 b = ivec4( skinIndex + 0.5 );
  return w.x * texelFetch( uHyToneTex, ivec2( b.x, slot ), 0 ).rgb + w.y * texelFetch( uHyToneTex, ivec2( b.y, slot ), 0 ).rgb
       + w.z * texelFetch( uHyToneTex, ivec2( b.z, slot ), 0 ).rgb + w.w * texelFetch( uHyToneTex, ivec2( b.w, slot ), 0 ).rgb;
}
#endif`;

const SURFACE_VERT_MAIN = /* glsl */ `
#ifdef USE_SKINNING
  vAvatarN = inverseTransformDirection( transformedNormal, viewMatrix );
  vHyTone0 = hyToneOf( 0 );
  vHyTone1 = hyToneOf( 1 );
  vHyTone2 = hyToneOf( 2 );
  vHyTone3 = hyToneOf( 3 );
#else
  vAvatarN = normalize( mat3( modelMatrix ) * normal );
  vHyTone0 = vHyTone1 = vHyTone2 = vHyTone3 = vec3( 0.0 );   // an object: the tone is measured on the person
#endif
vAvatarP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`;

const SURFACE_PARS = /* glsl */ `
uniform sampler2D uHyCrop0;
uniform sampler2D uHyCrop1;
uniform sampler2D uHyCrop2;
uniform sampler2D uHyCrop3;
uniform sampler2D uHyDep0;
uniform sampler2D uHyDep1;
uniform sampler2D uHyDep2;
uniform sampler2D uHyDep3;
uniform sampler2D uHyShare0;
uniform sampler2D uHyShare1;
uniform sampler2D uHyShare2;
uniform sampler2D uHyShare3;
uniform mat3 uHyR[ ${SLOTS} ];
uniform vec3 uHyT[ ${SLOTS} ];
uniform vec3 uHyC[ ${SLOTS} ];
uniform vec4 uHyK[ ${SLOTS} ];          // f, cx, cy, k1
uniform vec4 uHyCropRect[ ${SLOTS} ];   // px (all four rectangles: registered to the body)
uniform vec4 uHyKnown[ ${SLOTS} ];      // px, inside the frame
uniform vec4 uHyEdge[ ${SLOTS} ];       // px, the frame edges that cut this cut-out (far away otherwise)
uniform vec4 uHyDepRect[ ${SLOTS} ];    // px
uniform vec2 uHyDepZ[ ${SLOTS} ];       // near depth of the window (m), 1 / range
uniform float uHyOn[ ${SLOTS} ];
uniform float uHyOpen[ ${SLOTS} ];      // 1: this camera's matte contains an object that is drawn as a wireframe
uniform vec2 uHyDepSize;
uniform vec4 uHyTuneA;                  // view sigma, near0, near1, far floor
uniform vec4 uHyTuneB;                  // facing0, facing1, guard px, bias (m)
uniform vec4 uHyTuneC;                  // own0, own1, erode px, reach (fraction of the crop height)
uniform vec4 uHyTuneD;                  // brightness difference tolerated / rejected, body share at the outline / inside
uniform vec4 uHyTuneE;                  // angle from which the far facing limits apply, far facing0, far facing1, frame edge fade (px)
uniform vec4 uHyTuneF;                  // share of the body outside the matte: a sliver below, a hidden part above; neighbourhood (x reach); rim (px)
uniform vec4 uHyTuneG;                  // w: weight of a squarely seeing camera in the tone of the picture
uniform vec4 uHyTuneH;                  // hue difference tolerated / rejected, neighbourhood of the brightness test (px), view sigma of the tone
uniform vec4 uHyTuneI;                  // rim of the matte: width (px), factor on the hue limits there; far weight: angle at which it is halved, least share
uniform float uHyDebug;
uniform float uHyLift;
uniform vec4 uHyTrimOn;
uniform float uHyAlike;

// rgb / w: the cameras' pixels that passed the tests, weighted by view and facing; conf: how much of the point they cover.
// seen / sw: the pixel of the camera the viewer is at, as it is. tone / tw: the cameras' tones of this point, weighted by
// view and facing; own / ow: the tone of the camera the viewer is at.
struct HyAcc { vec3 rgb; float w; float conf; float alpha; vec3 dbg; vec3 tone; float tw; vec3 own; float ow; vec3 seen; float sw; vec3 sdbg; };

// Gamma 2 encoding the colours are compared and toned in. Signed, so that a dark pixel minus a tone and
// plus the same tone is the pixel again.
vec3 hyEnc( vec3 c ) { return sign( c ) * sqrt( abs( c ) ); }
vec3 hyDec( vec3 e ) { return e * abs( e ); }

float hyDepth( vec4 s ) { return ( s.r * 65280.0 + s.g * 255.0 ) / 65535.0; }

// Matte of a camera at frame pixel px (0 outside its crop).
float hyMatte( sampler2D crop, vec4 cr, vec2 px ) {
  vec2 uv = ( px - cr.xy ) / ( cr.zw - cr.xy );
  if ( uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0 ) return 0.0;
  return textureLod( crop, vec2( uv.x, 1.0 - uv.y ), 0.0 ).a;
}

// Smallest matte value within r px of px, where the matte is a (pixels at the matte's rim are part background).
float hyErode( sampler2D crop, vec4 cr, vec2 px, float a, float r ) {
  float d = r * 0.7071;
  for ( int j = 0; j < 4; j ++ ) {
    vec2 q = px + vec2( ( j & 1 ) == 0 ? d : - d, j < 2 ? d : - d );
    vec2 uv = ( q - cr.xy ) / ( cr.zw - cr.xy );
    a = min( a, uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0 ? 0.0 : textureLod( crop, vec2( uv.x, 1.0 - uv.y ), 0.0 ).a );
  }
  return a;
}

// How unlike this surface the footage at px looks: 0 like it, 1 something else (a wall seen through a gap in
// the matte or mixed into its rim, furniture or a carried object in front that the matte took for the person).
// ref: the colour the surface has over the whole clip, in the tone this camera films it in (gamma-encoded).
// Brightness is compared on the mean of the pixel s and four around it, r px away; hue on the pixel itself,
// with limits "strict" times as wide (see HYBRID_TUNING.alike0, rimPx).
float hyUnlike( sampler2D crop, vec4 cr, vec2 px, vec4 s, float r, vec3 ref, float strict ) {
  float d = r * 0.7071;
  vec3 own = hyEnc( s.rgb );
  vec3 sum = own * s.a;
  float w = s.a;
  for ( int j = 0; j < 4; j ++ ) {
    vec2 q = px + vec2( ( j & 1 ) == 0 ? d : - d, j < 2 ? d : - d );
    vec2 uv = ( q - cr.xy ) / ( cr.zw - cr.xy );
    if ( uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0 ) continue;
    vec4 t = textureLod( crop, vec2( uv.x, 1.0 - uv.y ), 0.0 );
    sum += hyEnc( t.rgb ) * t.a;
    w += t.a;
  }
  vec3 e = sum / max( w, 1e-4 ) - ref;
  float lum = ( e.r + e.g + e.b ) / 3.0;
  e = own - ref;
  vec3 hue = abs( e - ( e.r + e.g + e.b ) / 3.0 );
  return max( smoothstep( uHyTuneD.x, uHyTuneD.y, abs( lum ) ), smoothstep( uHyTuneH.x * strict, uHyTuneH.y * strict, max( hue.r, max( hue.g, hue.b ) ) ) );
}

// Share of the body in a neighbourhood about r px wide, as this camera sees it (from the depth map's mipmaps).
float hyCover( sampler2D dep, vec4 rect, vec2 px, float r ) {
  vec2 duv = clamp( ( px - rect.xy ) / ( rect.zw - rect.xy ), 0.0, 1.0 );
  vec2 t = uHyDepSize / ( rect.zw - rect.xy );   // texels per footage pixel
  return textureLod( dep, vec2( duv.x, 1.0 - duv.y ), log2( max( r * 0.5 * ( t.x + t.y ), 1.0 ) ) ).a;
}

// Is a body fragment outside the matte a sliver of the model sticking out of the footage outline (1),
// or a part this camera does not show because furniture or the frame edge hides it (0)? A sliver lies
// on the model's own outline with the matte right behind it, towards the inside of the body; a hidden
// part has more body behind it, not matte.
float hySliver( sampler2D crop, vec4 cr, sampler2D dep, vec4 dr, vec2 px, float r ) {
  float h = 0.5 * r;
  vec2 g = vec2( hyCover( dep, dr, px + vec2( h, 0.0 ), r ) - hyCover( dep, dr, px - vec2( h, 0.0 ), r ),
                 hyCover( dep, dr, px + vec2( 0.0, h ), r ) - hyCover( dep, dr, px - vec2( 0.0, h ), r ) );
  float edge = length( g );
  if ( edge < 1e-3 ) return 0.0;
  vec2 n = g / edge;
  float m = max( hyMatte( crop, cr, px + n * ( 0.35 * r ) ), max( hyMatte( crop, cr, px + n * ( 0.7 * r ) ), hyMatte( crop, cr, px + n * r ) ) );
  return smoothstep( 0.05, 0.35, m ) * smoothstep( 0.04, 0.16, edge );
}

// Share of the person around px (a neighbourhood about r px wide) that this camera's matte leaves out:
// small where a sliver of the model sticks out of the footage outline, large where furniture hid a part
// of the person from this camera.
float hyLeftOut( sampler2D share, vec4 rect, vec2 px, float r ) {
  vec2 duv = clamp( ( px - rect.xy ) / ( rect.zw - rect.xy ), 0.0, 1.0 );
  vec2 t = vec2( ${SHARE_W}.0, ${SHARE_H}.0 ) / ( rect.zw - rect.xy );   // texels per footage pixel
  vec4 s = textureLod( share, vec2( duv.x, 1.0 - duv.y ), log2( max( r * 0.5 * ( t.x + t.y ), 1.0 ) ) );
  return s.r / max( s.g, 1e-3 );
}

// 1 when a point at window depth dn is the first surface this camera sees along its ray.
// guard: an occluding edge lies within the guard radius (its true outline is only known to a few px).
// inside: share of the body in the neighbourhood (1 well inside the outline this camera sees, 0.5 on it).
float hyVisible( sampler2D dep, vec4 rect, vec2 px, float dn, float bias, out float guard, out float inside ) {
  guard = 0.0;
  inside = 0.0;
  vec2 duv = ( px - rect.xy ) / ( rect.zw - rect.xy );
  if ( duv.x <= 0.0 || duv.y <= 0.0 || duv.x >= 1.0 || duv.y >= 1.0 ) return 1.0;
  vec2 st = vec2( duv.x, 1.0 - duv.y ) * uHyDepSize - 0.5;
  vec2 f = fract( st );
  ivec2 i0 = ivec2( floor( st ) );
  ivec2 hi = ivec2( uHyDepSize ) - 1;
  float vis = 0.0;
  for ( int j = 0; j < 4; j ++ ) {
    ivec2 o = ivec2( j & 1, j >> 1 );
    vec4 s = texelFetch( dep, clamp( i0 + o, ivec2( 0 ), hi ), 0 );
    float w = ( o.x == 0 ? 1.0 - f.x : f.x ) * ( o.y == 0 ? 1.0 - f.y : f.y );
    vis += w * ( s.a < 0.5 ? 1.0 : 1.0 - smoothstep( bias, 2.0 * bias, dn - hyDepth( s ) ) );
  }
  vec2 r = uHyTuneB.z * uHyDepSize / ( rect.zw - rect.xy );   // guard radius in texels
  if ( uHyTuneB.z > 0.0 ) {
    for ( int j = 0; j < 4; j ++ ) {
      vec2 d = ( j < 2 ? vec2( r.x, 0.0 ) : vec2( 0.0, r.y ) ) * ( ( j & 1 ) == 0 ? 1.0 : - 1.0 );
      vec4 s = texelFetch( dep, clamp( ivec2( floor( st + 0.5 + d ) ), ivec2( 0 ), hi ), 0 );
      if ( s.a > 0.5 ) guard = max( guard, smoothstep( 3.0 * bias, 6.0 * bias, dn - hyDepth( s ) ) );
    }
  }
  // mip level whose texels are about one guard radius wide
  inside = textureLod( dep, vec2( duv.x, 1.0 - duv.y ), log2( max( 0.5 * ( r.x + r.y ), 1.0 ) ) ).a;
  return vis;
}

// X: fragment in fit coordinates, N: outward normal, V: unit vector to the viewer, baked: the 3D model's own colour here,
// tone: what this camera's footage of the shown frame adds to it at this point of the body (gamma-encoded).
void hyCamera( sampler2D crop, sampler2D dep, sampler2D share, int i, vec3 X, vec3 N, vec3 V, vec3 baked, vec3 tone, float trimOn, vec3 tint, inout HyAcc acc ) {
  if ( uHyOn[ i ] < 0.5 ) return;
  vec3 L = normalize( uHyC[ i ] - X );
  float ang = acos( clamp( dot( V, L ), - 1.0, 1.0 ) );
  float near = 1.0 - smoothstep( uHyTuneA.y, uHyTuneA.z, ang );
  // seen from the camera itself, whatever the viewer sees the camera saw: its pixels are used as they are
  float own = 1.0 - smoothstep( uHyTuneC.x, uHyTuneC.y, ang );
  // the tone of the picture here (footage and fill alike): the cameras' by how close each is to the viewing direction
  // and how squarely it sees this surface; at a camera, that camera's alone
  float cosN = dot( N, L );
  float c = max( cosN, 0.0 );
  float tw = exp( - ang * ang / ( uHyTuneH.w * uHyTuneH.w ) ) + uHyTuneG.w * c * c;
  acc.tone += tw * tone;
  acc.tw += tw;
  acc.own += own * tone;
  acc.ow += own;
  // a piece of a carried object that this camera's matte does not show: whatever the matte holds there is something else
  if ( trimOn < 0.0 ) return;
  vec3 Xc = uHyR[ i ] * X + uHyT[ i ];
  if ( Xc.z < 0.2 ) return;
  vec4 K = uHyK[ i ];
  vec2 xn = Xc.xy / Xc.z;
  // + 0.5: the calibration counts pixel centres as integers, textures count pixel edges
  vec2 px = K.x * xn * ( 1.0 + K.w * dot( xn, xn ) ) + K.yz + 0.5;
  vec4 cr = uHyCropRect[ i ];
  vec2 cuv = ( px - cr.xy ) / ( cr.zw - cr.xy );
  bool inCrop = cuv.x > 0.0 && cuv.y > 0.0 && cuv.x < 1.0 && cuv.y < 1.0;
  vec4 s = inCrop ? textureLod( crop, vec2( cuv.x, 1.0 - cuv.y ), 0.0 ) : vec4( 0.0 );
  float matte = smoothstep( 0.25, 0.75, s.a );
  // outline: next to this camera the footage outline is the truth. A sliver of the body that sticks out
  // of it is cut back to it; a part this camera does not show at all (behind furniture, below the frame)
  // is left alone and drawn from the other cameras or the 3D model's texture.
  vec4 kn = uHyKnown[ i ];
  vec4 dr = uHyDepRect[ i ];
  float reach = uHyTuneC.w * ( cr.w - cr.y );
  float leftOut = near > 0.0 ? hyLeftOut( share, dr, px, uHyTuneF.z * reach ) : 0.0;
  float hidden = smoothstep( uHyTuneF.x, uHyTuneF.y, leftOut );
  // (trimOn 2: a carried object whose matte contains it. Its pose is rougher than the body's and no part of it
  // is hidden from a camera that the matte does not already account for, so it is cut to the matte outright.)
  if ( near * trimOn > 0.0 && matte < 1.0 && px.x > kn.x && px.y > kn.y && px.x < kn.z && px.y < kn.w ) {
    float gate = trimOn > 1.5 ? 1.0 : hySliver( crop, cr, dep, dr, px, reach ) * ( 1.0 - hidden );
    acc.alpha *= mix( 1.0, matte, near * min( trimOn, 1.0 ) * gate );
  }
  if ( matte <= 0.0 ) return;
  float tanN = sqrt( max( 1.0 - cosN * cosN, 0.0 ) ) / max( cosN, 0.08 );
  float texel = Xc.z / K.x * 0.5 * ( ( dr.z - dr.x ) / uHyDepSize.x + ( dr.w - dr.y ) / uHyDepSize.y );
  float bias = ( uHyTuneB.w + 1.5 * texel * min( tanN, 6.0 ) ) * uHyDepZ[ i ].y;
  float guard;
  float inside;
  float vis = hyVisible( dep, dr, px, ( Xc.z - uHyDepZ[ i ].x ) * uHyDepZ[ i ].y, bias, guard, inside );
  // the further the viewer is from this camera, the more squarely it must have seen the surface:
  // a pixel taken at a grazing angle is stretched, and lands on the wrong spot if the fit is a pixel off
  float far = smoothstep( uHyTuneC.y, uHyTuneE.x, ang );
  float trust = vis * ( 1.0 - guard ) * smoothstep( mix( uHyTuneB.x, uHyTuneE.y, far ), mix( uHyTuneB.y, uHyTuneE.z, far ), cosN );
  // Away from the camera a pixel must be earned: matte and body are only known to a few pixels, so
  // what lies near either outline may be background, and so is what looks nothing like this surface
  // over the rest of the clip (furniture or a carried object in front that the matte took for the person).
  float core = smoothstep( 0.25, 0.75, hyErode( crop, cr, px, s.a, uHyTuneC.z ) );
  float unlike = 0.0;
  if ( uHyAlike > 0.0 ) {
    // within a few pixels of the matte's edge a pixel is tinted by what is behind the person: its hue must fit closely
    float ring = 1.0 - smoothstep( 0.25, 0.75, hyErode( crop, cr, px, s.a, uHyTuneI.x ) );
    unlike = uHyAlike * hyUnlike( crop, cr, px, s, uHyTuneH.z, hyEnc( baked ) + tone, mix( 1.0, uHyTuneI.y, ring ) );
  }
  trust *= core / max( matte, 1e-4 ) * smoothstep( uHyTuneD.z, uHyTuneD.w, inside ) * ( 1.0 - unlike );
  // Next to the camera its pixels are used as they are, except the rim of the matte along furniture that
  // hides the rest of the body: those pixels are part furniture, and the body goes on right below them.
  float rim = 1.0;
  if ( leftOut > 0.8 * uHyTuneF.x ) {
    float hcore = smoothstep( 0.25, 0.75, hyErode( crop, cr, px, s.a, uHyTuneF.w ) );
    rim = mix( 1.0, hcore / max( matte, 1e-4 ), smoothstep( 0.8 * uHyTuneF.x, 1.2 * uHyTuneF.x, leftOut ) );
  }
  // a body half out of this camera's frame: its pixels fade out towards the frame edge instead of ending in a line
  vec4 fe = uHyEdge[ i ];
  float edge = min( min( px.x - fe.x, fe.z - px.x ), min( px.y - fe.y, fe.w - px.y ) );
  // what this camera's cut-out shows of the point, and how much of that holds away from the camera
  float shown = matte * rim * smoothstep( 0.0, max( uHyTuneE.w, 1e-3 ), edge );
  float conf = shown * trust;
  // the camera the viewer looks along wins; further away a camera counts by how squarely it sees the surface,
  // the nearer of two such cameras more
  float q = ang / uHyTuneI.z;
  q *= q;
  float pref = exp( - ang * ang / ( uHyTuneA.x * uHyTuneA.x ) ) + uHyTuneA.w * c * c * mix( 1.0 / ( 1.0 + q * q ), 1.0, uHyTuneI.w );
  // the pixel in the baked texture's tone (the picture's tone is put on at the end, on footage and fill alike)
  vec3 pixel = hyDec( hyEnc( s.rgb ) - tone );
  acc.rgb += pixel * ( conf * pref );
  acc.dbg += tint * ( conf * pref );
  acc.w += conf * pref;
  acc.conf = max( acc.conf, conf );
  // The cut-out as it is, for the viewer at this camera: a layer of its own over the blend above, which fades out as
  // the viewer leaves. (Not a share of that blend: the camera the viewer looks along outweighs the others there so
  // much that a pixel that failed the tests, a line of floor in the matte's rim, would stay at full strength for as
  // long as a trace of this layer is left.)
  // An object in this matte that is drawn as a wireframe does not cover this surface any more, but its pixels are
  // still in the cut-out: of the layer only what this camera saw of the surface itself is kept (first along its
  // ray, clear of the object's outline, the surface's own colour). The rest comes from the blend and the fill.
  if ( uHyOpen[ i ] > 0.5 ) own *= vis * ( 1.0 - guard ) * ( 1.0 - unlike );
  acc.seen += pixel * ( own * shown );
  acc.sdbg += tint * ( own * shown );
  acc.sw += own * shown;
}
`;

/** Replaces <opaque_fragment>: outgoingLight holds the baked look on entry. */
const SURFACE_MAIN = /* glsl */ `
{
  vec3 hyN = normalize( vAvatarN );
  #ifdef DOUBLE_SIDED
    if ( ! gl_FrontFacing ) hyN = - hyN;
  #endif
  vec3 hyV = normalize( cameraPosition - vAvatarP );
  vec3 hyX = vAvatarP - vec3( 0.0, uHyLift, 0.0 );
  HyAcc hy = HyAcc( vec3( 0.0 ), 0.0, 0.0, 1.0, vec3( 0.0 ), vec3( 0.0 ), 0.0, vec3( 0.0 ), 0.0, vec3( 0.0 ), 0.0, vec3( 0.0 ) );
  hyCamera( uHyCrop0, uHyDep0, uHyShare0, 0, hyX, hyN, hyV, outgoingLight, vHyTone0, uHyTrimOn.x, vec3( 1.0, 0.1, 0.1 ), hy );
  hyCamera( uHyCrop1, uHyDep1, uHyShare1, 1, hyX, hyN, hyV, outgoingLight, vHyTone1, uHyTrimOn.y, vec3( 0.1, 1.0, 0.1 ), hy );
  hyCamera( uHyCrop2, uHyDep2, uHyShare2, 2, hyX, hyN, hyV, outgoingLight, vHyTone2, uHyTrimOn.z, vec3( 0.15, 0.3, 1.0 ), hy );
  hyCamera( uHyCrop3, uHyDep3, uHyShare3, 3, hyX, hyN, hyV, outgoingLight, vHyTone3, uHyTrimOn.w, vec3( 1.0, 0.9, 0.1 ), hy );
  float hyK = clamp( hy.conf, 0.0, 1.0 );
  float hyA = min( hy.sw, 1.0 );
  vec3 hyProj = hy.rgb / max( hy.w, 1e-6 );
  vec3 hySeen = hy.seen / max( hy.sw, 1e-6 );
  // debug 1: which camera each pixel comes from (red, green, blue, yellow; grey = baked texture)
  if ( uHyDebug > 0.5 ) {
    hyProj = mix( hy.dbg / max( hy.w, 1e-6 ), hyProj, 0.35 );
    hySeen = mix( hy.sdbg / max( hy.sw, 1e-6 ), hySeen, 0.35 );
    outgoingLight = mix( vec3( 0.5 ), outgoingLight, 0.35 );
  }
  // fill (in its own finish, if it has one), on it the pixels that hold from anywhere, on those the cut-out of the
  // camera the viewer is at
  vec3 hyFill = outgoingLight;
  /*HY_FILL*/
  outgoingLight = mix( mix( hyFill, hyProj, hyK ), hySeen, hyA );
  // Tone of the picture. Footage and fill were mixed in the baked texture's tone. At a camera the picture takes the
  // tone that camera films this part of the body in at this moment (its pixels are then exactly the recorded ones,
  // and the fill beside them matches); elsewhere the cameras' tones by direction and facing.
  if ( uHyDebug < 0.5 ) {
    vec3 hyTone = mix( hy.tone / max( hy.tw, 1e-5 ), hy.own / max( hy.ow, 1e-4 ), min( hy.ow, 1.0 ) );
    outgoingLight = max( hyDec( hyEnc( outgoingLight ) + hyTone ), 0.0 );
  }
  // baked alpha (gaps between a chair's slats) only where no camera pixel covers the panel
  float hyBase = clamp( ( diffuseColor.a - 0.5 ) / max( fwidth( diffuseColor.a ), 1e-4 ) + 0.5, 0.0, 1.0 );
  diffuseColor.a = hy.alpha * mix( hyBase, 1.0, 1.0 - ( 1.0 - hyK ) * ( 1.0 - hyA ) );
  if ( diffuseColor.a < 0.1 ) discard;
}
#include <opaque_fragment>`;

const DEPTH_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform mat3 uR;
uniform vec3 uT;
uniform vec4 uK;
uniform vec4 uRect;
uniform vec2 uZ;
uniform float uLift;
varying float vDn;
void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec3 X = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz - vec3( 0.0, uLift, 0.0 );
  vec3 Xc = uR * X + uT;
  vec2 xn = Xc.xy / max( Xc.z, 0.05 );
  vec2 px = uK.x * xn * ( 1.0 + uK.w * dot( xn, xn ) ) + uK.yz + 0.5;
  vec2 uv = ( px - uRect.xy ) / ( uRect.zw - uRect.xy );
  vDn = ( Xc.z - uZ.x ) * uZ.y;
  gl_Position = vec4( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, clamp( vDn, 0.0, 1.0 ) * 2.0 - 1.0, 1.0 );
}`;

/** R, G: depth in 16 bits. B: the same depth in 8 bits, A: 1; their mipmaps give "mean depth of the covered texels". */
const DEPTH_FRAG = /* glsl */ `
varying float vDn;
void main() {
  float d = clamp( vDn, 0.0, 1.0 );
  float q = floor( d * 65535.0 + 0.5 );
  float hi = floor( q / 256.0 );
  gl_FragColor = vec4( hi / 255.0, ( q - hi * 256.0 ) / 255.0, d, 1.0 );
}`;

const SHARE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

/**
 * Over a camera's depth map rectangle: R the person where the matte does not contain them, G the person, B the matte
 * (rendered from the depth map while it holds the person alone: the objects they handle have per-matte flags instead).
 * Their mipmaps give, for any neighbourhood, the share of the person that the matte leaves out (hyLeftOut).
 */
const SHARE_FRAG = /* glsl */ `
uniform sampler2D uDep;
uniform sampler2D uCrop;
uniform vec4 uDepRect;
uniform vec4 uCropRect;
varying vec2 vUv;                   // as the depth map: x right, y up
void main() {
  float body = textureLod( uDep, vUv, 1.0 ).a;
  vec2 size = uDepRect.zw - uDepRect.xy;
  vec2 px = uDepRect.xy + vec2( vUv.x, 1.0 - vUv.y ) * size;
  vec2 tap = 0.25 * size / vec2( ${SHARE_W}.0, ${SHARE_H}.0 );
  float m = 0.0;
  for ( int j = 0; j < 4; j ++ ) {
    vec2 q = px + tap * vec2( ( j & 1 ) == 0 ? 1.0 : - 1.0, j < 2 ? 1.0 : - 1.0 );
    vec2 uv = ( q - uCropRect.xy ) / ( uCropRect.zw - uCropRect.xy );
    if ( uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0 ) m += 0.25 * smoothstep( 0.25, 0.75, textureLod( uCrop, vec2( uv.x, 1.0 - uv.y ), 0.0 ).a );
  }
  gl_FragColor = vec4( body * ( 1.0 - m ), body, m, 1.0 );
}`;

const FRINGE_VERT = /* glsl */ `
attribute vec2 cropUv;              // x right, y down, 0..1 over the crop
uniform sampler2D uDep;
uniform mat3 uR;
uniform vec3 uT;
uniform vec4 uK;
uniform vec4 uCropRect;
uniform vec4 uDepRect;
uniform vec2 uDepZ;
uniform float uZRef;
uniform float uBack;
uniform float uLift;
varying vec2 vUv;
varying vec2 vDuv;
varying vec3 vWorld;
void main() {
  vec2 px = mix( uCropRect.xy, uCropRect.zw, cropUv );
  vec2 duv = ( px - uDepRect.xy ) / ( uDepRect.zw - uDepRect.xy );
  vDuv = vec2( duv.x, 1.0 - duv.y );
  // depth of the surface here, or of the nearest surface: finest mip level that has any
  float z = uZRef;
  for ( int l = 2; l <= 9; l ++ ) {
    vec4 s = textureLod( uDep, vDuv, float( l ) );
    if ( s.a > 0.04 ) { z = uDepZ.x + ( s.b / s.a ) / uDepZ.y; break; }
  }
  z += uBack;
  vec2 xd = ( px - 0.5 - uK.yz ) / uK.x;
  vec2 xu = xd;
  for ( int it = 0; it < 3; it ++ ) xu = xd / ( 1.0 + uK.w * dot( xu, xu ) );
  vec3 X = ( vec3( xu * z, z ) - uT ) * uR;    // R^T ( Xc - t )
  X.y += uLift;
  vWorld = X;
  vUv = vec2( cropUv.x, 1.0 - cropUv.y );
  gl_Position = projectionMatrix * viewMatrix * vec4( X, 1.0 );
}`;

const FRINGE_FRAG = /* glsl */ `
uniform sampler2D uCrop;
uniform sampler2D uDep;
uniform sampler2D uShare;
uniform vec3 uC;
uniform vec4 uCropRect;
uniform vec4 uDepRect;
uniform vec4 uTuneA;                // view sigma, near0, near1, far floor
uniform vec4 uTuneC;                // w: reach (fraction of the crop height)
uniform vec4 uTuneF;                // x: share of the person outside the matte from which a hidden part begins; z: neighbourhood (x reach); w: rim (px)
uniform vec4 uTuneG;                // next to a hidden part of the person: shares of hidden body between which the card fades out; neighbourhood (x reach)
uniform float uLift;
uniform float uOpen;                // 1: the objects the person handles are drawn as wireframes
varying vec2 vUv;
varying vec2 vDuv;
varying vec3 vWorld;
void main() {
  vec4 t = textureLod( uCrop, vUv, 0.0 );
  // already drawn by the body where the mesh covers this pixel (the card slides under its edge)
  float cover = textureLod( uDep, vDuv, 1.0 ).a;
  vec3 X = vWorld - vec3( 0.0, uLift, 0.0 );
  float ang = acos( clamp( dot( normalize( cameraPosition - vWorld ), normalize( uC - X ) ), - 1.0, 1.0 ) );
  float a = smoothstep( 0.25, 0.75, t.a ) * ( 1.0 - smoothstep( 0.8, 0.98, cover ) ) * ( 1.0 - smoothstep( uTuneA.y, uTuneA.z, ang ) );
  // Where the card borders the person and furniture hid the part of them next to it from this camera, it stops:
  // the body goes on there in the model's outline (see SHARE_FRAG), and the wider footage outline would end in a ledge.
  if ( a >= 0.1 && uTuneG.y > 0.0 ) {
    vec2 duv = clamp( vDuv, 0.0, 1.0 );
    float tx = 0.5 * ( ${SHARE_W}.0 / ( uDepRect.z - uDepRect.x ) + ${SHARE_H}.0 / ( uDepRect.w - uDepRect.y ) );   // texels per footage pixel
    float reach = uTuneC.w * ( uCropRect.w - uCropRect.y ) * tx;
    vec4 wide = textureLod( uShare, duv, log2( max( uTuneG.z * reach, 1.0 ) ) );
    float person = textureLod( uShare, duv, log2( max( reach, 1.0 ) ) ).g;
    a *= 1.0 - smoothstep( uTuneG.x, uTuneG.y, wide.r / max( wide.g, 0.02 ) ) * smoothstep( 0.03, 0.2, person );
    // and, as on the body (hyCamera), the rim of the matte along a hidden part is part furniture: not drawn
    vec4 mid = textureLod( uShare, duv, log2( max( uTuneF.z * reach, 1.0 ) ) );
    float leftOut = mid.r / max( mid.g, 0.02 );
    if ( uTuneF.w > 0.0 && leftOut > 0.8 * uTuneF.x ) {
      vec2 d = uTuneF.w * 0.7071 / ( uCropRect.zw - uCropRect.xy );
      float m = t.a;
      for ( int j = 0; j < 4; j ++ ) {
        vec2 uv = vUv + d * vec2( ( j & 1 ) == 0 ? 1.0 : - 1.0, j < 2 ? 1.0 : - 1.0 );
        m = min( m, uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0 ? 0.0 : textureLod( uCrop, uv, 0.0 ).a );
      }
      float core = smoothstep( 0.25, 0.75, m ) / max( smoothstep( 0.25, 0.75, t.a ), 1e-4 );
      a *= mix( 1.0, core, smoothstep( 0.8 * uTuneF.x, 1.2 * uTuneF.x, leftOut ) * smoothstep( 0.03, 0.2, mid.g ) );
    }
  }
  // Around an object that is drawn as a wireframe the matte pixels beside the mesh are that object's (its pose is
  // known to a few centimetres), not the person's hair or cloth: left out. The depth map holds person and objects,
  // the share map the person alone; what the first has more of within reach (uTuneC.w) is the object.
  if ( a >= 0.1 && uOpen > 0.5 ) {
    vec2 duv = clamp( vDuv, 0.0, 1.0 );
    float tx = 0.5 * ( ${SHARE_W}.0 / ( uDepRect.z - uDepRect.x ) + ${SHARE_H}.0 / ( uDepRect.w - uDepRect.y ) );
    float lod = log2( max( uTuneC.w * ( uCropRect.w - uCropRect.y ) * tx, 1.0 ) );
    a *= 1.0 - smoothstep( 0.02, 0.1, textureLod( uDep, duv, lod + 1.0 ).a - textureLod( uShare, duv, lod ).g );
  }
  if ( a < 0.1 ) discard;
  gl_FragColor = vec4( t.rgb, a );
  #include <colorspace_fragment>
}`;

function makeGrid(nx: number, ny: number) {
  const g = new THREE.BufferGeometry();
  const uv = new Float32Array((nx + 1) * (ny + 1) * 2);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) uv.set([i / nx, j / ny], (j * (nx + 1) + i) * 2);
  const idx: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((nx + 1) * (ny + 1) * 3), 3)); // computed in the vertex shader
  g.setAttribute("cropUv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const vec4s = () => Array.from({ length: SLOTS }, () => new THREE.Vector4());
const vec3s = () => Array.from({ length: SLOTS }, () => new THREE.Vector3());

interface Occluder {
  source: THREE.Mesh;
  twin: THREE.Mesh;
  own: HybridOwn;
  /** An object the person handles, not the person. */
  carried: boolean;
}

export class HybridProjector {
  /** Camera of every shader slot (null: unused). */
  readonly slots: (CameraId | null)[];
  /** Fringe cards (one per camera); add to the scene next to the body. */
  readonly fringe = new THREE.Group();

  private readonly frame: THREE.Vector2;
  private readonly targets: THREE.WebGLRenderTarget[];
  private readonly shares: THREE.WebGLRenderTarget[];
  private readonly shareScene = new THREE.Scene();
  private readonly shareMaterial: THREE.ShaderMaterial;
  private readonly screenGeometry = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  private readonly shared;
  /** Body part of every bone of the skin, and the unit of the tone values (AvatarProjection.tone). */
  private readonly toneJoints: readonly number[];
  private readonly toneScale: number;
  /** One texel per bone (x) and camera slot (y): the tone of that camera's footage on the bone's body part. */
  private readonly toneTexture: THREE.DataTexture;
  private readonly pass;
  private readonly depthScene = new THREE.Scene();
  private readonly depthCamera = new THREE.Camera();
  private readonly occluders: Occluder[] = [];
  private readonly fringeGeometry = makeGrid(48, 96);
  private readonly fringeMeshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly on: boolean[] = Array.from({ length: SLOTS }, () => false);
  private readonly zRef: number[] = Array.from({ length: SLOTS }, () => 0);
  private depthKey = "";
  private readonly tmp = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly clear = new THREE.Color();

  constructor(projection: AvatarProjection) {
    const ids = CAMERA_IDS.filter((id) => projection.cameras[id]).slice(0, SLOTS);
    this.slots = Array.from({ length: SLOTS }, (_, i) => ids[i] ?? null);
    this.frame = new THREE.Vector2(projection.frame[0], projection.frame[1]);
    this.targets = this.slots.map(() => {
      const rt = new THREE.WebGLRenderTarget(DEPTH_W, DEPTH_H, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
      rt.texture.name = "hybrid-depth";
      return rt;
    });
    this.shares = this.slots.map(() => {
      const rt = new THREE.WebGLRenderTarget(SHARE_W, SHARE_H, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        colorSpace: THREE.NoColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
      });
      rt.texture.name = "hybrid-share";
      return rt;
    });
    this.shareMaterial = new THREE.ShaderMaterial({
      uniforms: { uDep: { value: null }, uCrop: { value: null }, uDepRect: { value: new THREE.Vector4() }, uCropRect: { value: new THREE.Vector4() } },
      vertexShader: SHARE_VERT,
      fragmentShader: SHARE_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    const screen = new THREE.Mesh(this.screenGeometry, this.shareMaterial);
    screen.frustumCulled = false;
    this.shareScene.add(screen);
    this.materials.push(this.shareMaterial);
    this.toneJoints = projection.tone?.joints ?? [];
    this.toneScale = projection.tone?.scale ?? 1;
    this.toneTexture = new THREE.DataTexture(new Float32Array(Math.max(this.toneJoints.length, 1) * SLOTS * 4), Math.max(this.toneJoints.length, 1), SLOTS, THREE.RGBAFormat, THREE.FloatType);
    this.toneTexture.name = "hybrid-tone";
    this.toneTexture.needsUpdate = true;
    const t = HYBRID_TUNING;
    this.shared = {
      uHyCrop0: { value: null as THREE.Texture | null },
      uHyCrop1: { value: null as THREE.Texture | null },
      uHyCrop2: { value: null as THREE.Texture | null },
      uHyCrop3: { value: null as THREE.Texture | null },
      uHyDep0: { value: this.targets[0].texture },
      uHyDep1: { value: this.targets[1].texture },
      uHyDep2: { value: this.targets[2].texture },
      uHyDep3: { value: this.targets[3].texture },
      uHyShare0: { value: this.shares[0].texture },
      uHyShare1: { value: this.shares[1].texture },
      uHyShare2: { value: this.shares[2].texture },
      uHyShare3: { value: this.shares[3].texture },
      uHyR: { value: Array.from({ length: SLOTS }, () => new THREE.Matrix3()) },
      uHyT: { value: vec3s() },
      uHyC: { value: vec3s() },
      uHyK: { value: vec4s() },
      uHyCropRect: { value: vec4s() },
      uHyKnown: { value: vec4s() },
      uHyEdge: { value: vec4s() },
      uHyDepRect: { value: vec4s() },
      uHyDepZ: { value: Array.from({ length: SLOTS }, () => new THREE.Vector2(0, 1)) },
      uHyOn: { value: Array.from({ length: SLOTS }, () => 0) },
      uHyOpen: { value: Array.from({ length: SLOTS }, () => 0) },
      uHyToneTex: { value: this.toneTexture },
      uHyDepSize: { value: new THREE.Vector2(DEPTH_W, DEPTH_H) },
      uHyTuneA: { value: new THREE.Vector4(t.viewSigma, t.near0, t.near1, t.farFloor) },
      uHyTuneB: { value: new THREE.Vector4(t.facing0, t.facing1, t.guardPx, t.bias) },
      uHyTuneC: { value: new THREE.Vector4(t.own0, t.own1, t.erodePx, t.reach) },
      uHyTuneD: { value: new THREE.Vector4(t.alike0, t.alike1, t.inside0, t.inside1) },
      uHyTuneE: { value: new THREE.Vector4(t.farAngle, t.farFacing0, t.farFacing1, t.edgePx) },
      uHyTuneF: { value: new THREE.Vector4(t.hidden0, t.hidden1, t.hiddenReach, t.hiddenRimPx) },
      uHyTuneG: { value: new THREE.Vector4(t.outlineHidden0, t.outlineHidden1, t.outlineHiddenReach, t.toneFacing) },
      uHyTuneH: { value: new THREE.Vector4(t.hue0, t.hue1, t.alikePx, t.toneSigma) },
      uHyTuneI: { value: new THREE.Vector4(t.rimPx, t.rimHue, t.farTau, t.farMin) },
      uHyDebug: { value: 0 },
    };
    this.pass = {
      uR: { value: new THREE.Matrix3() },
      uT: { value: new THREE.Vector3() },
      uK: { value: new THREE.Vector4() },
      uRect: { value: new THREE.Vector4() },
      uZ: { value: new THREE.Vector2(0, 1) },
    };
    this.slots.forEach((id, i) => {
      const c = id ? projection.cameras[id] : undefined;
      if (!c) return;
      const [r0, r1, r2] = c.R;
      this.shared.uHyR.value[i].set(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], r2[0], r2[1], r2[2]);
      this.shared.uHyT.value[i].set(c.t[0], c.t[1], c.t[2]);
      this.shared.uHyC.value[i].set(c.C[0], c.C[1], c.C[2]);
      this.shared.uHyK.value[i].set(c.f, c.cx, c.cy, c.k1);
    });
    this.fringe.name = "hybrid-fringe";
    this.slots.forEach((_, i) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uCrop: { value: null },
          uDep: { value: this.targets[i].texture },
          uShare: { value: this.shares[i].texture },
          uR: { value: this.shared.uHyR.value[i] },
          uT: { value: this.shared.uHyT.value[i] },
          uK: { value: this.shared.uHyK.value[i] },
          uC: { value: this.shared.uHyC.value[i] },
          uCropRect: { value: this.shared.uHyCropRect.value[i] },
          uDepRect: { value: this.shared.uHyDepRect.value[i] },
          uDepZ: { value: this.shared.uHyDepZ.value[i] },
          uZRef: { value: 0 },
          uBack: { value: t.fringeBack },
          uLift: { value: 0 },
          uOpen: { value: 0 },
          uTuneA: this.shared.uHyTuneA,
          uTuneC: this.shared.uHyTuneC,
          uTuneF: this.shared.uHyTuneF,
          uTuneG: this.shared.uHyTuneG,
        },
        vertexShader: FRINGE_VERT,
        fragmentShader: FRINGE_FRAG,
        side: THREE.DoubleSide,
        alphaToCoverage: true,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.fringeGeometry, mat);
      mesh.name = `hybrid-fringe-${this.slots[i] ?? i}`;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      mesh.raycast = () => {};
      mesh.visible = false;
      this.materials.push(mat);
      this.fringeMeshes.push(mesh);
      this.fringe.add(mesh);
    });
  }

  /** Per-object uniforms; pass the same object to every material and occluder of one rigid object. */
  static own(): HybridOwn {
    return { uHyLift: { value: 0 }, uHyTrimOn: { value: new THREE.Vector4(0, 0, 0, 0) }, uHyAlike: { value: 1 } };
  }

  /** Uniforms that tune the blend (for experiments from the console). */
  get tuning() {
    return {
      a: this.shared.uHyTuneA.value,
      b: this.shared.uHyTuneB.value,
      c: this.shared.uHyTuneC.value,
      d: this.shared.uHyTuneD.value,
      e: this.shared.uHyTuneE.value,
      f: this.shared.uHyTuneF.value,
      g: this.shared.uHyTuneG.value,
      h: this.shared.uHyTuneH.value,
      i: this.shared.uHyTuneI.value,
      debug: this.shared.uHyDebug,
    };
  }

  /**
   * Material that draws a surface with the footage projected onto it, falling back to `map`.
   * `baked` is the GLSL that turns outgoingLight (the texel) into the 3D MODEL look.
   */
  surfaceMaterial(
    params: THREE.MeshBasicMaterialParameters,
    baked: string,
    own: HybridOwn = HybridProjector.own(),
    finish: HybridFinish | null = null,
  ): { material: THREE.MeshBasicMaterial; own: HybridOwn } {
    const material = new THREE.MeshBasicMaterial({ ...params, alphaToCoverage: true, toneMapped: false });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.shared, own, finish?.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${SURFACE_VARYINGS}\n${SURFACE_VERT_PARS}\n${finish?.vertexPars ?? ""}`)
        .replace("#include <project_vertex>", `#include <project_vertex>\n${SURFACE_VERT_MAIN}\n${finish?.vertexMain ?? ""}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${SURFACE_VARYINGS}\n${SURFACE_PARS}\n${finish?.fragmentPars ?? ""}`)
        .replace("#include <opaque_fragment>", `${baked}\n${SURFACE_MAIN.replace("/*HY_FILL*/", finish?.fill ?? "")}`);
    };
    material.customProgramCacheKey = () => (finish ? `sentry-hybrid-surface-${finish.key}` : "sentry-hybrid-surface");
    this.materials.push(material);
    return { material, own };
  }

  /**
   * Register a mesh drawn with a surfaceMaterial: it is rendered into the cameras' depth maps.
   * `carried`: an object the person handles (it hides the body like the body itself does, but is not counted as body
   * a matte should contain: its pieces have their own per-matte flags).
   */
  addOccluder(source: THREE.Mesh, own: HybridOwn, carried = false) {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.pass, uLift: own.uHyLift },
      vertexShader: DEPTH_VERT,
      fragmentShader: DEPTH_FRAG,
      side: THREE.DoubleSide,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    const skinned = source as THREE.SkinnedMesh;
    let twin: THREE.Mesh;
    if (skinned.isSkinnedMesh) {
      const s = new THREE.SkinnedMesh(source.geometry, mat);
      s.bind(skinned.skeleton, skinned.bindMatrix);
      twin = s;
    } else twin = new THREE.Mesh(source.geometry, mat);
    twin.matrixAutoUpdate = false;
    twin.frustumCulled = false;
    this.materials.push(mat);
    this.depthScene.add(twin);
    this.occluders.push({ source, twin, own, carried });
  }

  /** Tone of the cut-out in camera slot i (per body part, flat RGB; null: none) into the bone texture. */
  private setTone(i: number, tone: readonly number[] | null) {
    const data = this.toneTexture.image.data as Float32Array;
    const n = this.toneJoints.length;
    let changed = false;
    for (let j = 0; j < n; j++) {
      const part = this.toneJoints[j] * 3;
      const at = (i * n + j) * 4;
      for (let c = 0; c < 3; c++) {
        const v = tone ? (tone[part + c] ?? 0) * this.toneScale : 0;
        if (data[at + c] !== v) {
          data[at + c] = v;
          changed = true;
        }
      }
    }
    if (changed) this.toneTexture.needsUpdate = true;
  }

  /** Angle (rad) between the viewer's and each camera's direction to a point of the displayed body. */
  viewAngles(eye: THREE.Vector3, at: THREE.Vector3, lift: number, out: number[]) {
    const a = this.tmp.copy(eye).sub(at).normalize();
    for (let i = 0; i < SLOTS; i++) {
      if (!this.slots[i]) {
        out[i] = Math.PI;
        continue;
      }
      const b = this.tmpB.copy(this.shared.uHyC.value[i]);
      b.y += lift;
      b.sub(at).normalize();
      out[i] = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
    }
    return out;
  }

  /**
   * Footage of the shown frame. `crops[i]` belongs to slots[i] (null: that camera has nothing loaded),
   * `root` is the pelvis in fit coordinates, `lift` the body's display offset.
   */
  setFrame(crops: readonly (HybridCrop | null)[], root: THREE.Vector3, lift: number) {
    const u = this.shared;
    const samplers = [u.uHyCrop0, u.uHyCrop1, u.uHyCrop2, u.uHyCrop3];
    for (let i = 0; i < SLOTS; i++) {
      const c = this.slots[i] ? crops[i] : null;
      const fr = this.fringeMeshes[i];
      this.on[i] = !!c;
      u.uHyOn.value[i] = c ? 1 : 0;
      this.setTone(i, c?.tone ?? null);
      samplers[i].value = c?.texture ?? null;
      fr.visible = !!c;
      if (!c) continue;
      // footage pixel -> body pixel (identity unless the exporter registered this cut-out to the body)
      const a = c.register?.[0] ?? 1;
      const bx = c.register?.[1] ?? 0;
      const by = c.register?.[2] ?? 0;
      const x0 = a * c.rect[0] + bx;
      const y0 = a * c.rect[1] + by;
      const x1 = a * c.rect[2] + bx;
      const y1 = a * c.rect[3] + by;
      u.uHyCropRect.value[i].set(x0, y0, x1, y1);
      const fw = this.frame.x;
      const fh = this.frame.y;
      const k = c.known;
      // the matte says nothing outside the frame
      u.uHyKnown.value[i].set(
        a * Math.max(k ? k[0] : 0, 0) + bx,
        a * Math.max(k ? k[1] : 0, 0) + by,
        a * Math.min(k ? k[2] : fw, fw) + bx,
        a * Math.min(k ? k[3] : fh, fh) + by,
      );
      // frame edges the person is cut by (the cut-out reaches them): the footage fades out towards those
      const far = 1e6;
      u.uHyEdge.value[i].set(
        c.rect[0] <= 1 ? bx : -far,
        c.rect[1] <= 1 ? by : -far,
        c.rect[2] >= fw - 1 ? a * fw + bx : far,
        c.rect[3] >= fh - 1 ? a * fh + by : far,
      );
      // depth map: the crop plus a margin so the filtered lookups stay inside
      const mx = Math.max(16, 0.06 * (x1 - x0));
      const my = Math.max(16, 0.06 * (y1 - y0));
      u.uHyDepRect.value[i].set(x0 - mx, y0 - my, x1 + mx, y1 + my);
      const z = this.tmp.copy(root).applyMatrix3(u.uHyR.value[i]).add(u.uHyT.value[i]).z;
      this.zRef[i] = z;
      u.uHyDepZ.value[i].set(z - DEPTH_RANGE_M / 2, 1 / DEPTH_RANGE_M);
      fr.material.uniforms.uCrop.value = c.texture;
      fr.material.uniforms.uZRef.value = z;
      fr.material.uniforms.uLift.value = lift;
    }
  }

  /**
   * Render the body (already posed, world matrices up to date) from every active camera: first the person
   * alone and what of it each camera's matte leaves out, then together with the objects the person handles.
   * Skipped while `key` (pose + footage of the shown frame) is unchanged.
   */
  renderDepth(gl: THREE.WebGLRenderer, key: string) {
    if (key === this.depthKey) return;
    this.depthKey = key;
    let objects = false;
    for (const o of this.occluders) {
      o.twin.matrix.copy(o.source.matrixWorld);
      // bone matrices of this pose (the renderer refreshes a skeleton once per frame, which may be later)
      (o.source as THREE.SkinnedMesh).skeleton?.update();
      if (o.carried && o.source.visible) objects = true;
    }
    const prevTarget = gl.getRenderTarget();
    const prevAlpha = gl.getClearAlpha();
    const prevAuto = gl.autoClear;
    const prevXr = gl.xr.enabled;
    gl.getClearColor(this.clear);
    gl.xr.enabled = false; // the passes use their own projection, never the headset's
    gl.autoClear = true;
    gl.setClearColor(0x000000, 0);
    const u = this.shared;
    const crops = [u.uHyCrop0, u.uHyCrop1, u.uHyCrop2, u.uHyCrop3];
    for (let i = 0; i < SLOTS; i++) {
      if (!this.on[i]) continue;
      this.pass.uR.value.copy(u.uHyR.value[i]);
      this.pass.uT.value.copy(u.uHyT.value[i]);
      this.pass.uK.value.copy(u.uHyK.value[i]);
      this.pass.uRect.value.copy(u.uHyDepRect.value[i]);
      this.pass.uZ.value.copy(u.uHyDepZ.value[i]);
      for (const o of this.occluders) o.twin.visible = o.source.visible && !o.carried;
      gl.setRenderTarget(this.targets[i]);
      gl.render(this.depthScene, this.depthCamera);
      const s = this.shareMaterial.uniforms;
      s.uDep.value = this.targets[i].texture;
      s.uCrop.value = crops[i].value;
      s.uDepRect.value.copy(u.uHyDepRect.value[i]);
      s.uCropRect.value.copy(u.uHyCropRect.value[i]);
      gl.setRenderTarget(this.shares[i]);
      gl.render(this.shareScene, this.depthCamera);
      if (!objects) continue;
      for (const o of this.occluders) o.twin.visible = o.source.visible;
      gl.setRenderTarget(this.targets[i]);
      gl.render(this.depthScene, this.depthCamera);
    }
    this.shareMaterial.uniforms.uCrop.value = null;
    gl.setRenderTarget(prevTarget);
    gl.setClearColor(this.clear, prevAlpha);
    gl.autoClear = prevAuto;
    gl.xr.enabled = prevXr;
  }

  /**
   * The handled objects are drawn as wireframes (`wire`), so their pixels are kept off the person.
   * `slotBits` (bit i = slots[i]): the cameras whose matte of the shown frame contains such an object. In those
   * the object's pixels lie on the person's surface; in every camera they line the outline of the object where it
   * stands in front of the person, which is what the cards draw.
   */
  setSeeThrough(slotBits: number, wire: boolean) {
    for (let i = 0; i < SLOTS; i++) {
      this.shared.uHyOpen.value[i] = wire ? (slotBits >> i) & 1 : 0;
      this.fringeMeshes[i].material.uniforms.uOpen.value = wire ? 1 : 0;
    }
  }

  /** Force the next renderDepth (after a prop finished loading, a context restore...). */
  invalidate() {
    this.depthKey = "";
  }

  dispose() {
    this.fringe.removeFromParent();
    this.fringeGeometry.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.targets) t.dispose();
    for (const t of this.shares) t.dispose();
    this.toneTexture.dispose();
    this.screenGeometry.dispose();
    for (const o of this.occluders) {
      o.twin.removeFromParent();
    }
    this.occluders.length = 0;
  }
}
