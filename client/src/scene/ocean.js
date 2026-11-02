import * as THREE from 'three';
import { BOARD_CENTER, CELL, SUN_DIRECTION, WAVES, waveK, waveW } from './constants.js';

const OCEAN_SIZE = 1500;
const OCEAN_SEGMENTS = 320;

/** Carte de normales périodique : somme de sinus à fréquences entières, donc raccord parfait. */
function createNormalMap(size = 512, waves = 48) {
  const seedRandom = (() => { let s = 7; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
  const list = Array.from({ length: waves }, (_, i) => {
    const f = 1 + Math.floor(1 + (i * i) / 14);
    const angle = seedRandom() * Math.PI * 2;
    return {
      kx: Math.round(Math.cos(angle) * f), ky: Math.round(Math.sin(angle) * f),
      a: 1 / (f ** 1.05), p: seedRandom() * Math.PI * 2,
    };
  });
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0;
      let dy = 0;
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      for (const w of list) {
        const c = w.a * Math.cos(w.kx * u + w.ky * v + w.p);
        dx += c * w.kx;
        dy += c * w.ky;
      }
      const i = (y * size + x) * 4;
      data[i] = Math.min(255, Math.max(0, 128 + dx * 11));
      data[i + 1] = Math.min(255, Math.max(0, 128 + dy * 11));
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

const VERTEX = /* glsl */`
uniform float uTime;
uniform vec4 uWaves[4];
uniform float uOmega[4];
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vCrest;

void main() {
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 q = p;
  vec3 n = vec3(0.0, 1.0, 0.0);
  float crest = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 d = uWaves[i].xy;
    float a = uWaves[i].z, k = uWaves[i].w;
    float phase = k * dot(d, p.xz) - uOmega[i] * uTime;
    float s = sin(phase), c = cos(phase);
    q.y += a * s;
    q.xz += d * c * a * 0.8;
    n.xz -= d * a * k * c;
    crest += s * a;
  }
  vWorld = q;
  vNormalW = normalize(n);
  vCrest = crest;
  gl_Position = projectionMatrix * viewMatrix * vec4(q, 1.0);
}`;

const FRAGMENT = /* glsl */`
precision highp float;
uniform float uTime;
uniform sampler2D uNormal;
uniform sampler2D uSky;
uniform sampler2D uDecal;
uniform sampler2D uCells;
uniform vec3 uSun;
uniform vec3 uCam;
uniform vec2 uBoardCenters;
uniform vec3 uHover;        // x = plateau (-1 aucun, 0 = nous, 1 = ennemi), yz = case
uniform vec3 uHoverColor;
uniform float uBoardGlow[2];
uniform float uCell;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vCrest;

vec3 sky(vec3 d, float lod) {
  vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.14159265 + 0.5);
  return textureLod(uSky, uv, lod).rgb;
}

float gridLine(vec2 p, float width) {
  vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
  return 1.0 - min(min(g.x, g.y) / width, 1.0);
}

vec4 board(vec3 w, float center, int index) {
  vec2 p = vec2(w.x - center, w.z) / uCell + 5.0;   // 0..10 sur le plateau
  if (p.x < -0.04 || p.y < -0.04 || p.x > 10.04 || p.y > 10.04) return vec4(0.0);
  vec2 cell = floor(clamp(p, 0.0, 9.999));
  vec4 tint = texture2D(uCells, (vec2(cell.x + float(index) * 10.0, cell.y) + 0.5) / vec2(20.0, 10.0));
  vec3 color = tint.rgb;
  float alpha = tint.a;
  vec3 line = vec3(0.8, 0.94, 1.0);
  float a = gridLine(p, 1.05) * 0.36;
  vec2 edgePx = abs(min(p, 10.0 - p)) / fwidth(p);
  a = max(a, (1.0 - smoothstep(0.6, 1.6, min(edgePx.x, edgePx.y))) * 0.62);
  color = mix(color, line, clamp(a * 2.0, 0.0, 1.0));
  alpha = max(alpha, a);
  // Case survolée.
  if (uHover.x == float(index) && cell == uHover.yz) {
    vec2 f = fract(p);
    float inner = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    float pulse = 0.62 + 0.2 * sin(uTime * 6.0);
    float rim = 1.0 - smoothstep(0.02, 0.09, inner);
    color = mix(color, uHoverColor, max(rim, 0.26));
    alpha = max(alpha, max(rim, 0.3) * pulse);
  }
  return vec4(color, alpha * uBoardGlow[index]);
}

void main() {
  vec3 viewVec = uCam - vWorld;
  float dist = length(viewVec);
  vec3 V = viewVec / dist;
  vec2 uv = vWorld.xz;
  float detail = 1.0 / (1.0 + dist * 0.0028);

  vec2 n1 = texture2D(uNormal, uv / 83.0 + uTime * vec2(0.0058, 0.0031)).xy - 0.5;
  vec2 n2 = texture2D(uNormal, uv / 37.0 + uTime * vec2(-0.0072, 0.0104)).xy - 0.5;
  vec2 n3 = texture2D(uNormal, uv / 15.0 + uTime * vec2(0.0171, -0.0121)).xy - 0.5;
  vec2 n4 = texture2D(uNormal, uv / 6.3 + uTime * vec2(-0.0312, -0.0244)).xy - 0.5;
  vec2 nd = n1 * 0.95 + n2 * 0.72 + n3 * 0.46 * detail + n4 * 0.24 * detail;
  vec3 N = normalize(vec3(vNormalW.x + nd.x * 0.62, 1.0, vNormalW.z + nd.y * 0.62));

  float cosV = max(dot(N, V), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosV, 5.0);
  fresnel = min(fresnel, 0.7);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.01;
  R = normalize(R);
  vec3 reflected = sky(R, 3.2);
  // Vu de haut, le ciel couchant saturerait l'eau : on ne garde sa pleine force qu'en lumière rasante.
  reflected = mix(min(reflected, vec3(0.75)), reflected, pow(1.0 - cosV, 2.5));

  // Corps de l'eau : bleu pétrole profond, diffusion turquoise sur les flancs face au soleil.
  float back = pow(max(dot(V, -normalize(vec3(uSun.x, 0.0, uSun.z))), 0.0), 3.0);
  float sss = clamp(0.45 + vCrest * 0.65, 0.0, 1.0) * (0.22 + back * 0.6);
  vec3 body = mix(vec3(0.012, 0.062, 0.092), vec3(0.03, 0.17, 0.18), sss);
  body += vec3(0.20, 0.09, 0.035) * 0.05 * max(dot(N, uSun), 0.0);

  vec3 color = mix(body, reflected, fresnel);

  // Reflet du soleil : scintillement concentré autour de la colonne de lumière.
  float sunDot = max(dot(R, uSun), 0.0);
  color += vec3(9.0, 4.3, 1.5) * pow(sunDot, 520.0) * 2.2;
  color += vec3(1.7, 0.66, 0.2) * pow(sunDot, 90.0) * 0.07;

  // Écume des crêtes.
  float foamNoise = texture2D(uNormal, uv / 9.0 + uTime * 0.012).x;
  float patchNoise = texture2D(uNormal, uv / 260.0 + uTime * 0.0016).x;
  float crest = smoothstep(0.62, 0.98, vCrest * 0.55 + patchNoise * 0.72 + (n2.x + n3.y) * 0.34);
  vec3 foamColor = vec3(0.62, 0.66, 0.70) + vec3(0.42, 0.26, 0.16) * max(dot(N, uSun), 0.0);
  color = mix(color, foamColor, crest * 0.07);

  // Carte des décalcomanies : écume des coques (r), nappes de mazout (g), assombrissement de contact (b).
  vec2 decalUv = vec2((vWorld.x + 130.0) / 260.0, (vWorld.z + 65.0) / 130.0);
  if (decalUv.x > 0.0 && decalUv.x < 1.0 && decalUv.y > 0.0 && decalUv.y < 1.0) {
    vec2 wobble = (n3 + n4) * 0.004;
    vec4 decal = texture2D(uDecal, decalUv + wobble);
    float foam = decal.r * smoothstep(0.3, 0.72, foamNoise + decal.r * 0.34);
    color *= 1.0 - decal.b * 0.42;
    color = mix(color, foamColor * 1.05, clamp(foam, 0.0, 0.8));
    vec3 oil = vec3(0.007, 0.006, 0.008) + 0.14 * vec3(0.5 + 0.5 * sin(foamNoise * 21.0), 0.5 + 0.5 * sin(foamNoise * 26.0 + 2.0), 0.5 + 0.5 * sin(foamNoise * 31.0 + 4.0)) * fresnel;
    color = mix(color, oil, decal.g * 0.86);
  }

  // Perspective aérienne vers l'horizon.
  vec3 horizon = sky(normalize(vec3(-V.x, 0.015, -V.z)), 2.2);
  color = mix(color, horizon, 1.0 - exp(-pow(dist * 0.00165, 1.7)));

  // Plateaux tactiques.
  for (int i = 0; i < 2; i++) {
    vec4 b = board(vWorld, i == 0 ? uBoardCenters.x : uBoardCenters.y, i);
    color = mix(color, b.rgb * 1.5, b.a);
  }
  gl_FragColor = vec4(color, 1.0);
}`;

/** Grille de teintes 20×10 : une case de plateau = un texel, mise à jour sans recompiler. */
class CellTints {
  constructor() {
    this.data = new Uint8Array(20 * 10 * 4);
    this.texture = new THREE.DataTexture(this.data, 20, 10, THREE.RGBAFormat);
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  set(board, x, y, [r, g, b], a) {
    const i = (y * 20 + x + (board === 'enemy' ? 10 : 0)) * 4;
    this.data.set([r, g, b, Math.round(a * 255)], i);
    this.texture.needsUpdate = true;
  }

  clear(board) {
    const offset = board === 'enemy' ? 10 : 0;
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) this.data[(y * 20 + x + offset) * 4 + 3] = 0;
    }
    this.texture.needsUpdate = true;
  }
}

export class Ocean {
  constructor(scene, skyTexture, decalTexture) {
    this.cells = new CellTints();
    const geometry = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, OCEAN_SEGMENTS, OCEAN_SEGMENTS);
    geometry.rotateX(-Math.PI / 2);
    this.uniforms = {
      uTime: { value: 0 },
      uNormal: { value: createNormalMap() },
      uSky: { value: skyTexture },
      uDecal: { value: decalTexture },
      uCells: { value: this.cells.texture },
      uSun: { value: SUN_DIRECTION },
      uCam: { value: new THREE.Vector3() },
      uBoardCenters: { value: new THREE.Vector2(BOARD_CENTER.own, BOARD_CENTER.enemy) },
      uHover: { value: new THREE.Vector3(-1, 0, 0) },
      uHoverColor: { value: new THREE.Color(1, 0.72, 0.25) },
      uBoardGlow: { value: [0, 0] },
      uCell: { value: CELL },
      uWaves: { value: WAVES.map(([dx, dz, a], i) => new THREE.Vector4(dx, dz, a, waveK[i])) },
      uOmega: { value: waveW },
    };
    this.mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, uniforms: this.uniforms,
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.glowTarget = [0, 0];
  }

  setHover(board, cell, color) {
    const u = this.uniforms.uHover.value;
    if (!cell) { u.set(-1, 0, 0); return; }
    u.set(board === 'own' ? 0 : 1, cell.x, cell.y);
    if (color) this.uniforms.uHoverColor.value.setRGB(...color);
  }

  showBoards(own, enemy) { this.glowTarget = [own, enemy]; }

  update(t, dt, camera) {
    this.uniforms.uTime.value = t;
    this.uniforms.uCam.value.copy(camera.position);
    const step = OCEAN_SIZE / OCEAN_SEGMENTS;
    this.mesh.position.x = Math.round(camera.position.x / step) * step;
    this.mesh.position.z = Math.round(camera.position.z / step) * step;
    const glow = this.uniforms.uBoardGlow.value;
    for (let i = 0; i < 2; i++) glow[i] += (this.glowTarget[i] - glow[i]) * Math.min(1, dt * 3);
  }
}
