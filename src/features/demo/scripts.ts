import type { CameraId } from "../../types/security";
import * as demo1 from "./demoScript";
import * as demo2 from "./demo2Script";
import type { BuildState, DemoCam, DemoContext, LookState, PathState, WallState } from "./demoScript";
import { useDemoStore, type DemoVariant } from "./useDemoStore";

/** What the director, the wall and the path need of a walkthrough: all pure functions of the demo clock. */
export interface DemoScript {
  DEMO_DURATION: number;
  /** Incident time the recordings are brought to behind the loading card. */
  DEMO_START_TIME: number;
  /** Incident time whose subject position stands in when he is absent at the shown time. */
  FREEZE_TIME: number;
  /** Demo time applied behind the loading card while the recordings are brought to DEMO_START_TIME. */
  PREP_E: number;
  WARM_UP: readonly number[];
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
  /** Metres beyond the room's walls up to which the scan is drawn (null: all of it). */
  roomMarginAt?: (e: number) => number | null;
  coverageAt: (e: number) => number;
  pathAt: (e: number) => PathState;
  tagLiftAt: (e: number) => number;
  lookStateAt: (e: number) => LookState;
  wallAt: (e: number) => WallState;
  cameraAt: (e: number, ctx: DemoContext) => DemoCam;
  cctvAt: (e: number) => CameraId | null;
  cctvFilterAt: (e: number) => string;
}

const SCRIPTS: Record<DemoVariant, DemoScript> = { 1: demo1, 2: demo2 };

/** The script of the walkthrough that is playing (DEMO MODE or DEMO 2). */
export const activeScript = (): DemoScript => SCRIPTS[useDemoStore.getState().variant];
