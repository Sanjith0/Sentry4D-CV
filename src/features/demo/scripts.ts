import type { CameraId } from "../../types/security";
import * as demo1 from "./demoScript";
import * as demo2 from "./demo2Script";
import type { BuildState, DemoCam, DemoContext, LookState, PathState, WallState } from "./demoScript";
import { useDemoStore, type DemoVariant } from "./useDemoStore";

/** What the director, the wall and the path need of a walkthrough: all pure functions of the demo clock. */
export interface DemoScript {
  DEMO_DURATION: number;
  /** Incident time whose subject position stands in when he is absent at the shown time. */
  FREEZE_TIME: number;
  /** Demo time applied behind the loading card while the recordings are brought to their first frame (incidentTime(0)). */
  PREP_E: number;
  /**
   * Seconds the recordings already play, behind the loading card, before the clock starts: the walkthrough
   * opens on pictures that are moving. Left out: they start with the clock.
   */
  ROLL_IN?: number;
  /**
   * The wall opens on earlier footage than the clock's own: from incident time `time` on (at demo time 0),
   * until demo time `until`. Second players show it (leadIn.ts, WallState.leadIn) while the recordings play
   * on the clock's time, out of sight. Needs ROLL_IN: those players are started with the recordings.
   */
  LEAD_IN?: { readonly time: number; readonly until: number };
  WARM_UP: readonly number[];
  /** Fonts its captions are set in (CSS font shorthand): fetched behind the loading card. */
  FONTS?: readonly string[];
  /** The camera whose tile the wall pushes into. */
  LOCK_FIRST: CameraId;
  incidentTime: (e: number) => number;
  videosLive: (e: number) => boolean;
  videoRate: (e: number) => number;
  frameWanted: (masterTime: number) => boolean;
  buildAt: (e: number, floorY: number, topY: number) => BuildState;
  ceilingShown: (e: number, cutY: number, wireY: number) => boolean;
  windowFramesAt: (e: number) => number;
  /** The window wall's glass dissolves with its frames (views from outside it). */
  glassWithFrames?: boolean;
  /** The height (world y) up to which the window wall stands, as it rises from the floor; null or left out: all of it. */
  windowRiseAt?: (e: number, floorY: number, topY: number) => number | null;
  /** Metres beyond the room's walls up to which the scan is drawn (null: all of it). */
  roomMarginAt?: (e: number) => number | null;
  coverageAt: (e: number) => number;
  pathAt: (e: number) => PathState;
  tagLiftAt: (e: number) => number;
  /** The cameras' labels in the scene: 0..1 shown; plain: their name only. Left out: as the viewer draws them. */
  cameraTagsAt?: (e: number) => { show: number; plain: boolean };
  lookStateAt: (e: number) => LookState;
  wallAt: (e: number) => WallState;
  cameraAt: (e: number, ctx: DemoContext) => DemoCam;
  cctvAt: (e: number) => CameraId | null;
  cctvFilterAt: (e: number) => string;
}

const SCRIPTS: Record<DemoVariant, DemoScript> = { 1: demo1, 2: demo2 };

/** The script of the walkthrough that is playing (DEMO MODE or DEMO 2). */
export const activeScript = (): DemoScript => SCRIPTS[useDemoStore.getState().variant];
