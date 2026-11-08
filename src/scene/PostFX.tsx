import { useEffect, useMemo, type ReactElement } from "react";
import { BrightnessContrast, EffectComposer, HueSaturation, N8AO, Vignette } from "@react-three/postprocessing";
import { roomConfig } from "../config/roomConfig";
import { useReplayStore } from "../store/useReplayStore";
import { useViewStore } from "../store/useViewStore";
import { SharpenEffect } from "./effects/SharpenEffect";

/** Post-processing chain. Disabled entirely in "performance" quality. Tunables in roomConfig.rendering. */
export function PostFX() {
  const quality = useViewStore((s) => s.quality);
  const cctv = useReplayStore((s) => s.cameraMode === "cctv");
  const r = roomConfig.rendering;
  const sharpen = useMemo(() => new SharpenEffect(r.sharpen), [r.sharpen]);
  useEffect(() => () => sharpen.dispose(), [sharpen]);

  if (quality === "performance") return null;

  const effects: ReactElement[] = [];
  if (r.ao) {
    effects.push(
      <N8AO
        key="ao"
        aoRadius={r.aoRadius}
        intensity={r.aoIntensity}
        distanceFalloff={0.5}
        quality={quality === "ultra" ? "high" : "medium"}
        // halfRes uses a legacy multi-render-target shim that crashes on three r187.
        halfRes={false}
      />,
    );
  }
  if (r.sharpen > 0) effects.push(<primitive key="sharpen" object={sharpen} />);
  if (r.contrast) effects.push(<BrightnessContrast key="bc" contrast={r.contrast} />);
  if (r.saturation) effects.push(<HueSaturation key="hs" saturation={r.saturation} />);
  if (cctv) effects.push(<Vignette key="vig" offset={0.3} darkness={0.6} />);

  return <EffectComposer multisampling={quality === "ultra" ? 8 : 4}>{effects}</EffectComposer>;
}
