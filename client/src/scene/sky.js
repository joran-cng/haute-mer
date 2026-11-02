import * as THREE from 'three';
import { SUN_DIRECTION } from './constants.js';

const NOISE_GLSL = /* glsl */`
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p, int octaves) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < octaves; i++) { v += a * vnoise(p); p = m * p; a *= 0.5; }
  return v;
}`;

const BAKE_FRAGMENT = /* glsl */`
precision highp float;
varying vec2 vUv;
uniform vec3 uSun;
${NOISE_GLSL}
const float PI = 3.14159265;

vec3 atmosphere(vec3 d) {
  float h = max(d.y, 0.0);
  float toSun = max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSun.x, 0.0, uSun.z))), 0.0);
  vec3 zenith = vec3(0.040, 0.082, 0.205);
  vec3 mid = mix(vec3(0.20, 0.25, 0.42), vec3(0.62, 0.42, 0.42), pow(toSun, 3.0));
  vec3 horizon = mix(vec3(0.36, 0.33, 0.42), vec3(1.9, 0.72, 0.22), pow(toSun, 4.0));
  vec3 c = mix(horizon, mid, smoothstep(0.0, 0.14, h));
  c = mix(c, zenith, smoothstep(0.06, 0.62, h));
  float glow = max(dot(d, uSun), 0.0);
  c += vec3(1.5, 0.52, 0.14) * pow(glow, 40.0) * 0.55;
  c += vec3(3.2, 1.5, 0.5) * pow(glow, 420.0) * 1.1;
  return c;
}

float cloudDensity(vec2 p, float coverage) {
  vec2 warp = vec2(fbm(p * 0.7 + 3.1, 4), fbm(p * 0.7 - 7.7, 4));
  float f = fbm(p + warp * 1.25, 7);
  return smoothstep(coverage, coverage + 0.3, f);
}

void main() {
  float lon = (vUv.x - 0.5) * 2.0 * PI;
  float lat = (vUv.y - 0.5) * PI;
  vec3 d = vec3(cos(lat) * cos(lon), sin(lat), cos(lat) * sin(lon));
  vec3 c = atmosphere(d);

  if (d.y > -0.02) {
    float y = max(d.y, 0.0) + 0.1;
    vec2 p = d.xz / y;
    vec2 s = uSun.xz / (uSun.y + 0.1);
    vec2 lightDir = normalize(s - p);
    float toSun = max(dot(d, uSun), 0.0);

    // Banc bas : cumulus épais, bords rétroéclairés par le soleil couchant.
    vec2 lowP = p * vec2(1.05, 1.9) + vec2(4.2, 1.3);
    float low = cloudDensity(lowP, 0.39);
    float lit = low - cloudDensity(lowP + lightDir * 0.2, 0.39);
    float rim = clamp(lit * 1.7 + 0.42, 0.0, 1.0);
    vec3 shade = mix(vec3(0.075, 0.075, 0.125), vec3(0.34, 0.26, 0.30), rim);
    vec3 fire = vec3(3.4, 1.46, 0.48) * pow(toSun, 3.0) + vec3(0.92, 0.46, 0.34) * pow(toSun, 0.8);
    vec3 cloud = shade + fire * pow(rim, 3.2) * 0.72;
    float fade = smoothstep(0.0, 0.05, d.y + 0.015) * (1.0 - smoothstep(0.55, 0.95, d.y) * 0.72);
    c = mix(c, cloud, low * fade * 0.98);

    // Voile de cirrus haut, très fin.
    float high = smoothstep(0.48, 0.86, fbm(p * vec2(0.34, 1.05) + 11.0, 6));
    c = mix(c, c + vec3(1.2, 0.78, 0.66) * (0.34 + pow(toSun, 3.0)), high * 0.34 * smoothstep(0.03, 0.2, d.y));

    // Brume d'horizon : efface la jonction ciel / mer.
    c = mix(c, atmosphere(vec3(d.x, 0.012, d.z)), (1.0 - smoothstep(0.0, 0.05, d.y)) * 0.62);
  }

  float disc = smoothstep(0.99972, 0.99986, dot(d, uSun));
  c += vec3(16.0, 7.0, 2.0) * disc;
  if (d.y < 0.0) c = mix(c, vec3(0.02, 0.03, 0.05), smoothstep(0.0, -0.12, d.y));
  gl_FragColor = vec4(c, 1.0);
}`;

const FULLSCREEN_VERTEX = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Calcule le ciel une seule fois dans une texture : 7 octaves de bruit par pixel seraient trop chères à 60 Hz. */
export function createSky(renderer, scene) {
  const target = new THREE.WebGLRenderTarget(2048, 1024, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    wrapS: THREE.RepeatWrapping,
    depthBuffer: false,
  });
  target.texture.mapping = THREE.EquirectangularReflectionMapping;
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;

  const bakeScene = new THREE.Scene();
  const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader: BAKE_FRAGMENT,
    uniforms: { uSun: { value: SUN_DIRECTION } },
    depthTest: false,
    depthWrite: false,
  }));
  bakeScene.add(quad);
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  renderer.render(bakeScene, bakeCamera);
  renderer.setRenderTarget(previous);
  quad.geometry.dispose();
  quad.material.dispose();

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1800, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { uSky: { value: target.texture } },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform sampler2D uSky;
        void main() {
          vec3 d = normalize(vDir);
          vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.14159265 + 0.5);
          gl_FragColor = vec4(textureLod(uSky, uv, 0.0).rgb, 1.0);
        }`,
    }),
  );
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  scene.add(dome);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(target.texture).texture;
  pmrem.dispose();
  scene.environment = env;
  scene.environmentIntensity = 0.85;

  return { texture: target.texture, dome };
}
