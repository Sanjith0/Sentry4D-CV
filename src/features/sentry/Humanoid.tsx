import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import * as THREE from "three";

/** Pose inputs for one frame; everything derives from master time upstream. */
export interface HumanoidPose {
  gaitPhase: number;
  /** 0 = standing, 1 = full walking swing. */
  stride: number;
  estimated: boolean;
}

export interface HumanoidHandle {
  setPose: (p: HumanoidPose) => void;
}

interface Props {
  heightM: number;
  build: number;
  color: string;
  highlighted: boolean;
  xray: boolean;
}

const REF_HEIGHT = 1.75;

interface PartProps {
  skin: THREE.Material;
  hull: THREE.Material;
  /** X-ray glow material, or null when X-ray is off. */
  xray: THREE.Material | null;
  outline: number;
}

/** Capsule + outline hull. */
function Capsule({ radius, length, position, scale, skin, hull, xray, outline }: PartProps & { radius: number; length: number; position?: [number, number, number]; scale?: [number, number, number] }) {
  const len = Math.max(length - 2 * radius, 0.01);
  return (
    <group position={position} scale={scale}>
      <mesh material={skin}>
        <capsuleGeometry args={[radius, len, 6, 14]} />
      </mesh>
      <mesh material={hull}>
        <capsuleGeometry args={[radius + outline, len, 6, 14]} />
      </mesh>
      {xray && (
        <mesh material={xray} renderOrder={1000}>
          <capsuleGeometry args={[radius + outline, len, 6, 14]} />
        </mesh>
      )}
    </group>
  );
}

/** Capsule hanging down from its parent pivot. */
function Limb({ radius, length, ...rest }: PartProps & { radius: number; length: number }) {
  return <Capsule radius={radius} length={length} position={[0, -length / 2, 0]} {...rest} />;
}

/**
 * Stylized volumetric humanoid (capsules + sphere head) built at 1.75 m and scaled
 * to `heightM`. Faces +Z. Origin at the feet. Cyan inverted-hull outline; with
 * X-ray on, a depth-test-free silhouette shows it through walls.
 */
export const Humanoid = forwardRef<HumanoidHandle, Props>(function Humanoid({ heightM, build, color, highlighted, xray }, ref) {
  const leftLeg = useRef<THREE.Group>(null);
  const rightLeg = useRef<THREE.Group>(null);
  const leftShin = useRef<THREE.Group>(null);
  const rightShin = useRef<THREE.Group>(null);
  const leftArm = useRef<THREE.Group>(null);
  const rightArm = useRef<THREE.Group>(null);
  const torso = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);

  const mats = useMemo(() => {
    const skin = new THREE.MeshStandardMaterial({ color: "#253246", roughness: 0.6, metalness: 0.05, emissive: new THREE.Color(color), emissiveIntensity: 0.04 });
    // X-ray: fresnel glow drawn ONLY where something is in front of the body
    // (depthFunc GreaterDepth); depth testing for the rest of the scene is untouched.
    const ghost = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uStrength;
        varying vec3 vN; varying vec3 vV;
        void main() {
          float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
          gl_FragColor = vec4(uColor * (0.35 + 1.6 * rim) * uStrength, 0.25 + 0.6 * rim);
        }`,
      transparent: true,
      depthWrite: false,
      depthFunc: THREE.GreaterDepth,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    // Inverted hull: back faces of a slightly larger twin read as an outline.
    const hull = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, toneMapped: false });
    return { skin, ghost, hull };
  }, [color]);

  useImperativeHandle(ref, () => ({
    setPose({ gaitPhase, stride, estimated }) {
      const swing = 0.55 * stride;
      const s = Math.sin(gaitPhase);
      const c = Math.cos(gaitPhase);
      if (leftLeg.current) leftLeg.current.rotation.x = s * swing;
      if (rightLeg.current) rightLeg.current.rotation.x = -s * swing;
      // Knees bend on the back-swing only.
      if (leftShin.current) leftShin.current.rotation.x = Math.max(0, -c) * 0.7 * stride;
      if (rightShin.current) rightShin.current.rotation.x = Math.max(0, c) * 0.7 * stride;
      if (leftArm.current) leftArm.current.rotation.x = -s * swing * 0.8;
      if (rightArm.current) rightArm.current.rotation.x = s * swing * 0.8;
      if (torso.current) torso.current.rotation.y = s * 0.08 * stride;
      if (body.current) body.current.position.y = Math.abs(c) * 0.025 * stride; // bob
      mats.skin.transparent = estimated;
      mats.skin.opacity = estimated ? 0.55 : 1;
      // Estimated (no observation) → amber outline.
      mats.hull.color.set(estimated ? "#f59e0b" : color);
      (mats.ghost.uniforms.uColor.value as THREE.Color).set(estimated ? "#f59e0b" : color);
    },
  }));

  // Outline hull thickness (m, before height scaling).
  const outline = highlighted ? 0.022 : 0.013;
  const k = heightM / REF_HEIGHT;
  const w = build;

  const limb = { skin: mats.skin, hull: mats.hull, xray: xray ? mats.ghost : null, outline };

  return (
    <group scale={[k, k, k]}>
      <group ref={body}>
        {/* Legs: hips at 0.92 m, thigh 0.45, shin 0.45 */}
        {[
          [leftLeg, leftShin, 0.1 * w],
          [rightLeg, rightShin, -0.1 * w],
        ].map(([leg, shin, x], i) => (
          <group key={i} ref={leg as React.RefObject<THREE.Group>} position={[x as number, 0.92, 0]}>
            <Limb radius={0.075} length={0.46} {...limb} />
            <group ref={shin as React.RefObject<THREE.Group>} position={[0, -0.46, 0]}>
              <Limb radius={0.06} length={0.44} {...limb} />
              {/* foot */}
              <mesh position={[0, -0.44, 0.05]} material={mats.skin}>
                <boxGeometry args={[0.09, 0.05, 0.22]} />
              </mesh>
              <mesh position={[0, -0.44, 0.05]} material={mats.hull}>
                <boxGeometry args={[0.09 + 2 * outline, 0.05 + 2 * outline, 0.22 + 2 * outline]} />
              </mesh>
              {xray && (
                <mesh position={[0, -0.44, 0.05]} material={mats.ghost} renderOrder={1000}>
                  <boxGeometry args={[0.09 + 2 * outline, 0.05 + 2 * outline, 0.22 + 2 * outline]} />
                </mesh>
              )}
            </group>
          </group>
        ))}

        <group ref={torso} position={[0, 0.92, 0]}>
          {/* pelvis + torso */}
          <Capsule radius={0.13 * w} length={0.32 * w} position={[0, 0.06, 0]} {...limb} />
          <Capsule radius={0.17} length={0.64} position={[0, 0.33, 0]} scale={[w, 1, 0.72]} {...limb} />
          {/* neck + head */}
          <mesh position={[0, 0.6, 0]} material={mats.skin}>
            <cylinderGeometry args={[0.05, 0.055, 0.08, 12]} />
          </mesh>
          <group position={[0, 0.73, 0.01]} scale={[1, 1.12, 1.05]}>
            <mesh material={mats.skin}>
              <sphereGeometry args={[0.105, 20, 16]} />
            </mesh>
            <mesh material={mats.hull}>
              <sphereGeometry args={[0.105 + outline, 20, 16]} />
            </mesh>
            {xray && (
              <mesh material={mats.ghost} renderOrder={1000}>
                <sphereGeometry args={[0.105 + outline, 20, 16]} />
              </mesh>
            )}
          </group>
          {/* visor: shows facing direction */}
          <mesh position={[0, 0.745, 0.095]} rotation-x={-0.1}>
            <boxGeometry args={[0.12, 0.03, 0.02]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
          {/* arms: shoulders at 0.52 above hips */}
          {[
            [leftArm, 0.23 * w],
            [rightArm, -0.23 * w],
          ].map(([arm, x], i) => (
            <group key={i} ref={arm as React.RefObject<THREE.Group>} position={[x as number, 0.52, 0]} rotation-z={(i ? -1 : 1) * 0.06}>
              <Limb radius={0.05} length={0.62} {...limb} />
            </group>
          ))}
        </group>
      </group>

    </group>
  );
});
