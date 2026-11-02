import * as THREE from 'three';
import { puffAtlas } from './textures.js';

/**
 * Particules animées dans le shader : le CPU n'écrit que la naissance d'une particule
 * (tampon circulaire), le GPU calcule ensuite position, couleur et taille à partir de uTime.
 */
class ParticlePool {
  constructor(scene, atlas, capacity, blending, wind = new THREE.Vector3()) {
    this.capacity = capacity;
    this.cursor = 0;
    const geometry = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.attrs = {
      aOrigin: new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4), // xyz + naissance
      aVelocity: new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4), // xyz + durée
      aSize: new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4), // début, fin, gravité, graine
      aColorA: new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
      aColorB: new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4),
    };
    for (const [name, attr] of Object.entries(this.attrs)) {
      attr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attr);
    }
    geometry.instanceCount = capacity;
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending,
      uniforms: { uTime: { value: 0 }, uAtlas: { value: atlas }, uWind: { value: wind } },
      vertexShader: /* glsl */`
        attribute vec4 aOrigin, aVelocity, aSize, aColorA, aColorB;
        uniform float uTime;
        uniform vec3 uWind;
        varying vec2 vUv;
        varying vec4 vColor;
        void main() {
          float age = (uTime - aOrigin.w) / aVelocity.w;
          if (age < 0.0 || age > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float t = uTime - aOrigin.w;
          float drag = (1.0 - exp(-t * 1.6)) / 1.6;
          vec3 world = aOrigin.xyz + aVelocity.xyz * drag + uWind * t * max(aSize.y - aSize.x, 0.0) / 14.0;
          world.y -= aSize.z * t * t * 0.5;
          vec4 view = viewMatrix * vec4(world, 1.0);
          float size = mix(aSize.x, aSize.y, 1.0 - pow(1.0 - age, 2.2));
          float rot = aSize.w * 6.28 + t * (aSize.w - 0.5) * 0.9;
          vec2 p = position.xy * size;
          view.xy += vec2(p.x * cos(rot) - p.y * sin(rot), p.x * sin(rot) + p.y * cos(rot));
          gl_Position = projectionMatrix * view;
          float frame = floor(aSize.w * 16.0);
          vUv = (uv + vec2(mod(frame, 4.0), floor(frame / 4.0))) / 4.0;
          vColor = mix(aColorA, aColorB, age);
          vColor.a *= smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.55, 1.0, age));
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uAtlas;
        varying vec2 vUv;
        varying vec4 vColor;
        void main() {
          float a = texture2D(uAtlas, vUv).a * vColor.a;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor.rgb, a);
        }`,
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  spawn(t, p) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.capacity;
    const { aOrigin, aVelocity, aSize, aColorA, aColorB } = this.attrs;
    aOrigin.setXYZW(i, p.x, p.y, p.z, t);
    aVelocity.setXYZW(i, p.vx ?? 0, p.vy ?? 0, p.vz ?? 0, p.life);
    aSize.setXYZW(i, p.size, p.endSize ?? p.size * 2, p.gravity ?? 0, Math.random());
    aColorA.setXYZW(i, ...p.colorA);
    aColorB.setXYZW(i, ...(p.colorB ?? p.colorA));
    this.dirty = true;
  }

  update(t) {
    this.material.uniforms.uTime.value = t;
    if (!this.dirty) return;
    for (const attr of Object.values(this.attrs)) attr.needsUpdate = true;
    this.dirty = false;
  }
}

const rand = (a, b) => a + Math.random() * (b - a);

export class Particles {
  constructor(scene) {
    const atlas = puffAtlas();
    this.smoke = new ParticlePool(scene, atlas, 2600, THREE.NormalBlending, new THREE.Vector3(5.2, 0, 1.6));
    this.fire = new ParticlePool(scene, atlas, 1800, THREE.AdditiveBlending);
    this.t = 0;
    this.emitters = [];
    this.bolts = [];
  }

  update(t, dt, lowQuality) {
    this.t = t;
    for (const e of this.emitters) {
      e.acc += dt * e.rate * (lowQuality ? 0.5 : 1);
      while (e.acc >= 1) {
        e.acc -= 1;
        this.emitFlame(e);
      }
    }
    this.smoke.update(t);
    this.fire.update(t);
  }

  emitFlame(e) {
    const { x, y, z } = e.position();
    this.fire.spawn(this.t, {
      x: x + rand(-e.radius, e.radius), y: y + rand(0, 0.3), z: z + rand(-e.radius, e.radius),
      vx: rand(-0.3, 0.3), vy: rand(2.4, 5), vz: rand(-0.3, 0.3),
      life: rand(0.5, 1), size: rand(1.4, 2.3) * e.scale, endSize: 0.5 * e.scale,
      colorA: [3.6, 1.3, 0.24, 0.62], colorB: [1.4, 0.18, 0.02, 0.05],
    });
    if (Math.random() < 0.55) {
      this.smoke.spawn(this.t, {
        x: x + rand(-e.radius, e.radius), y: y + 1.5, z: z + rand(-e.radius, e.radius),
        vx: 0.8 + rand(-0.5, 0.5), vy: rand(3.5, 6.5), vz: rand(-0.8, 0.2),
        life: rand(3.5, 6.5), size: rand(1.6, 2.8) * e.scale, endSize: rand(8, 14) * e.scale,
        gravity: -0.5, colorA: [0.03, 0.028, 0.03, 0.72], colorB: [0.075, 0.068, 0.07, 0],
      });
    }
  }

  addFire(position, { rate = 24, radius = 0.8, scale = 1 } = {}) {
    const e = { position, rate, radius, scale, acc: 0 };
    this.emitters.push(e);
    return e;
  }

  removeFire(e) { this.emitters = this.emitters.filter((x) => x !== e); }
  clearFires() { this.emitters = []; }

  splash(p) {
    const t = this.t;
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * 6.28;
      const r = Math.random() ** 2 * 1.5;
      const up = rand(14, 42);
      this.smoke.spawn(t, {
        x: p.x + Math.cos(a) * r, y: 0.4, z: p.z + Math.sin(a) * r,
        vx: Math.cos(a) * rand(1, 7), vy: up, vz: Math.sin(a) * rand(1, 7),
        life: rand(1.3, 2.5), size: rand(0.9, 2), endSize: rand(3, 7), gravity: 12,
        colorA: [1.3, 1.26, 1.22, 0.88], colorB: [0.78, 0.68, 0.64, 0],
      });
    }
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * 6.28;
      this.smoke.spawn(t, {
        x: p.x, y: 0.5, z: p.z, vx: Math.cos(a) * rand(7, 16), vy: rand(0.2, 2), vz: Math.sin(a) * rand(7, 16),
        life: rand(0.9, 1.9), size: 2, endSize: rand(6, 10), colorA: [1, 0.98, 0.95, 0.5], colorB: [0.85, 0.8, 0.76, 0],
      });
    }
  }

  explosion(p, scale = 1) {
    const t = this.t;
    for (let i = 0; i < 32; i++) {
      const dir = new THREE.Vector3().randomDirection();
      dir.y = Math.abs(dir.y) * 1.6;
      const speed = rand(5, 24) * scale;
      this.fire.spawn(t, {
        x: p.x, y: p.y + 1, z: p.z, vx: dir.x * speed, vy: dir.y * speed, vz: dir.z * speed,
        life: rand(0.35, 0.9), size: rand(2, 4.4) * scale, endSize: rand(5, 10) * scale,
        colorA: [3.2, 1.25, 0.26, 0.5], colorB: [1.2, 0.18, 0.02, 0],
      });
    }
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * 6.28;
      this.smoke.spawn(t, {
        x: p.x + Math.cos(a) * 2, y: p.y + rand(1, 4), z: p.z + Math.sin(a) * 2,
        vx: Math.cos(a) * rand(1, 7), vy: rand(4, 15), vz: Math.sin(a) * rand(1, 7),
        life: rand(2.5, 6), size: rand(3, 6) * scale, endSize: rand(13, 26) * scale, gravity: -0.1,
        colorA: [0.02, 0.018, 0.02, 0.86], colorB: [0.08, 0.07, 0.07, 0],
      });
    }
    for (let i = 0; i < 40; i++) {
      const dir = new THREE.Vector3().randomDirection();
      dir.y = Math.abs(dir.y) + 0.3;
      const speed = rand(15, 45);
      this.fire.spawn(t, {
        x: p.x, y: p.y + 1, z: p.z, vx: dir.x * speed, vy: dir.y * speed, vz: dir.z * speed,
        life: rand(0.8, 1.9), size: 0.5, endSize: 0.12, gravity: 18,
        colorA: [16, 8, 2.5, 1], colorB: [6, 1, 0.1, 0],
      });
    }
  }

  muzzleFlash(p, dir) {
    const t = this.t;
    for (let i = 0; i < 16; i++) {
      this.fire.spawn(t, {
        x: p.x, y: p.y, z: p.z, vx: dir.x * rand(5, 30) + rand(-3, 3), vy: dir.y * rand(5, 30) + rand(-3, 3), vz: dir.z * rand(5, 30) + rand(-3, 3),
        life: rand(0.1, 0.28), size: rand(1.5, 3.4), endSize: 4.5, colorA: [6, 3, 0.8, 0.8], colorB: [2, 0.4, 0.05, 0],
      });
    }
    for (let i = 0; i < 12; i++) {
      this.smoke.spawn(t, {
        x: p.x, y: p.y, z: p.z, vx: dir.x * rand(2, 13) + rand(-1, 1), vy: dir.y * rand(2, 13) + rand(0, 2), vz: dir.z * rand(2, 13) + rand(-1, 1),
        life: rand(1.4, 3.2), size: 2, endSize: rand(7, 11), colorA: [0.56, 0.52, 0.5, 0.55], colorB: [0.5, 0.44, 0.42, 0],
      });
    }
  }

  trail(p) {
    this.fire.spawn(this.t, { x: p.x, y: p.y, z: p.z, life: 0.24, size: 1.4, endSize: 0.2, colorA: [14, 6, 1.8, 1], colorB: [4, 1, 0.1, 0] });
    this.smoke.spawn(this.t, { x: p.x, y: p.y, z: p.z, vy: 0.5, life: 0.9, size: 0.5, endSize: 1.7, colorA: [0.6, 0.55, 0.52, 0.22], colorB: [0.6, 0.55, 0.52, 0] });
  }
}
