import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { demoLook } from "./demoLook";
import { fitLabels, releaseLabels } from "./labelFit";

/**
 * Demo walkthrough: keeps the scene's floating labels out of the frame's edge, the captions and each other
 * (see labelFit). Mounted after the components that move the viewpoint and the subject, so that it works on
 * this frame's positions.
 */
export function DemoLabels() {
  const fitted = useRef(false);
  useFrame(({ camera, size }) => {
    if (demoLook.active) {
      fitLabels(camera, size);
      fitted.current = true;
    } else if (fitted.current) {
      releaseLabels();
      fitted.current = false;
    }
  });
  return null;
}
