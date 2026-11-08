// Export the subject's tracked floor positions + per-camera prompt boxes for a clip window,
// using the APP'S OWN code (trajectory fusion + calibrated projection) via Vite SSR. No browser needed.
//
// Usage (from the repo root):
//   node experiments/reconstruction/preprocess/export_track.mjs --clip clip02 --t0 4.3 --t1 25.6 --fps 15 --cams cam1,cam2,cam3,cam4
// Output: experiments/reconstruction/data/<clip>/track.json  (same format segment_sam2.py reads)
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith("--") ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const clip = args.clip ?? "clip01";
const t0 = Number(args.t0 ?? 8.6);
const t1 = Number(args.t1 ?? 10.4);
const fps = Number(args.fps ?? 15);
const cams = (args.cams ?? "cam1,cam2").split(",");
const person = args.person ?? "person_01";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

const server = await createServer({ root, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { buildTrajectory } = await server.ssrLoadModule("/src/features/sentry/trajectory.ts");
  const { worldToVideoPixel } = await server.ssrLoadModule("/src/lib/videoProjection.ts");
  const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
  const poses = read("src/config/camera-poses.json");
  const data = read("src/data/person-annotations.json");
  const ds = data.datasets.find((d) => d.personId === person);
  if (!ds) throw new Error(`no dataset ${person}`);
  const frame = { width: 1920, height: 1080 };
  // Room interior bounds (roomConfig.interior after grounding) are only used to flag edge cases.
  const tr = buildTrajectory({ observations: ds.observations, poses, frameFor: () => frame, bounds: null });
  const n = Math.round((t1 - t0) * fps);
  const out = [];
  for (let k = 0; k < n; k++) {
    const t = Math.round((t0 + k / fps) * 1e4) / 1e4;
    const s = tr.sample(t);
    const row = { k, masterTime: t, visible: s.visible, position: s.position.map((v) => +v.toFixed(4)), status: s.status, boxes: {}, boxInFrame: {} };
    for (const c of cams) {
      const pts = [];
      let behind = false;
      for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]])
        for (const y of [0, 1.8]) {
          const p = worldToVideoPixel(poses[c], [s.position[0] + dx, y, s.position[2] + dz], frame);
          if (p.behind || !p.pixel) behind = true;
          else pts.push([p.pixel[0] * 1920, p.pixel[1] * 1080]);
        }
      if (behind || !pts.length) {
        row.boxes[c] = null;
        row.boxInFrame[c] = 0;
        continue;
      }
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v));
      const area = (b[2] - b[0]) * (b[3] - b[1]);
      const ix = Math.max(0, Math.min(b[2], 1920) - Math.max(b[0], 0));
      const iy = Math.max(0, Math.min(b[3], 1080) - Math.max(b[1], 0));
      row.boxes[c] = b;
      row.boxInFrame[c] = area > 0 ? +((ix * iy) / area).toFixed(3) : 0;
    }
    out.push(row);
  }
  const dir = path.join(root, "experiments/reconstruction/data", clip);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "track.json"), JSON.stringify(out, null, 1));
  console.log(`wrote ${out.length} rows -> experiments/reconstruction/data/${clip}/track.json (trajectory ${tr.start.toFixed(2)}-${tr.end.toFixed(2)} s)`);
} finally {
  await server.close();
}
