import { Effect, EffectAttribute } from "postprocessing";
import { Uniform } from "three";

const fragmentShader = /* glsl */ `
uniform float strength;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec2 t = texelSize;
  vec3 n = texture2D(inputBuffer, uv + vec2(0.0, t.y)).rgb;
  vec3 s = texture2D(inputBuffer, uv - vec2(0.0, t.y)).rgb;
  vec3 e = texture2D(inputBuffer, uv + vec2(t.x, 0.0)).rgb;
  vec3 w = texture2D(inputBuffer, uv - vec2(t.x, 0.0)).rgb;
  vec3 blur = (n + s + e + w) * 0.25;
  // Unsharp mask; clamp detail to avoid halos on hard edges.
  vec3 detail = clamp(inputColor.rgb - blur, -0.12, 0.12);
  outputColor = vec4(max(inputColor.rgb + detail * strength * 4.0, 0.0), inputColor.a);
}
`;

/** Lightweight unsharp-mask sharpen to counteract soft scan textures. */
export class SharpenEffect extends Effect {
  constructor(strength = 0.35) {
    super("SharpenEffect", fragmentShader, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([["strength", new Uniform(strength)]]),
    });
  }
  get strength(): number {
    return this.uniforms.get("strength")!.value;
  }
  set strength(v: number) {
    this.uniforms.get("strength")!.value = v;
  }
}
