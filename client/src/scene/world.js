import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { shipCells } from '../../../shared/game.js';
import { BOARD_CENTER, CELL, cellToWorld, SUN_DIRECTION, waveHeight, worldToCell } from './constants.js';
import { Ocean } from './ocean.js';
import { Particles } from './particles.js';
import { createShipModel, placementOf } from './ships.js';
import { createSky } from './sky.js';
import { DecalMap, gridLabelTexture } from './textures.js';

const FinishShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime; varying vec2 vUv;
    float rnd(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233))+uTime)*43758.5453);}
    void main(){
      vec2 c=vUv-.5;
      vec3 col=texture2D(tDiffuse,vUv).rgb;
      col*=1.-dot(c,c)*.62;
      col+=(rnd(vUv)-.5)*.012;
      gl_FragColor=vec4(col,1.);
    }`,
};

const VIEWS = {
  own: { pos: [BOARD_CENTER.own, 118, 96], look: [BOARD_CENTER.own, 0, 2] },
  enemy: { pos: [BOARD_CENTER.enemy, 118, 96], look: [BOARD_CENTER.enemy, 0, 2] },
};

const SHOT_FLIGHT_S = 1.35;
const SINK_DURATION_S = 9;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class World {
  constructor(container) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.6;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(this.pixelRatio);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 16 / 9, 1, 4000);
    this.camera.position.set(-40, 10, 92);

    const sky = createSky(renderer, this.scene);
    this.decals = new DecalMap();
    this.ocean = new Ocean(this.scene, sky.texture, this.decals.texture);
    this.particles = new Particles(this.scene);

    const sun = new THREE.DirectionalLight(0xffc089, 3.6);
    sun.position.copy(SUN_DIRECTION).multiplyScalar(320);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.25;
    Object.assign(sun.shadow.camera, { left: -135, right: 135, top: 90, bottom: -90, near: 60, far: 620 });
    sun.target.position.set(0, 0, 0);
    this.scene.add(sun, sun.target);
    this.scene.add(new THREE.HemisphereLight(0xa8b6d0, 0x1c3234, 0.9));
    // Lumière d'appoint côté caméra : le soleil est de face, les navires seraient sinon en contre-jour.
    const fill = new THREE.DirectionalLight(0xd8dcec, 1.5);
    fill.position.set(-120, 150, 240);
    this.scene.add(fill);
    this.flash = new THREE.PointLight(0xffa04a, 0, 150, 1.6);
    this.scene.add(this.flash);

    this.addCoast();
    this.addGridLabels();

    const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.18, 0.6, 2.4);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.finish = new ShaderPass(FinishShader);
    this.composer.addPass(this.finish);

    this.ships = { own: new Map(), enemy: new Map() };
    this.ghost = null;
    this.shells = [];
    this.fires = { own: [], enemy: [] };
    this.markers = new THREE.Group();
    this.scene.add(this.markers);
    this.cameraState = {
      from: this.camera.position.clone(), fromLook: new THREE.Vector3(),
      to: this.camera.position.clone(), toLook: new THREE.Vector3(-40, 5, 0),
      look: new THREE.Vector3(-40, 5, 0), t: 1, duration: 1, mode: 'orbit', orbit: 0,
    };
    this.shake = 0;
    this.clock = new THREE.Clock();
    this.time = 0;
    this.frames = 0;
    this.fpsWindow = 0;
    this.lowQuality = false;
    this.onShellImpact = null;
    this.spawnReviewFleet();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    renderer.setAnimationLoop(() => this.frame());
  }

  /** Côte lointaine : silhouettes noyées dans la brume pour donner l'échelle. */
  addCoast() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x241f2c, fog: false });
    const ridges = [[-760, -950, 1300, 92], [420, -1050, 1100, 62], [1050, -500, 620, 46], [-1160, -180, 640, 58]];
    for (const [x, z, w, h] of ridges) {
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2, 0);
      const n = 38;
      for (let i = 1; i < n; i++) {
        const u = i / n;
        const env = Math.sin(u * Math.PI) ** 0.6;
        const v = 0.55 + 0.27 * Math.sin(u * 17.1 + x) + 0.18 * Math.sin(u * 41.7 + z);
        shape.lineTo(-w / 2 + u * w, h * env * v);
      }
      shape.lineTo(w / 2, 0);
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
      mesh.position.set(x, -1, z);
      mesh.lookAt(0, 0, 0);
      this.scene.add(mesh);
    }
  }

  addGridLabels() {
    const geo = new THREE.PlaneGeometry(5.2, 5.2);
    this.labels = new THREE.Group();
    this.labelMats = { own: [], enemy: [] };
    const label = (board, text, x, z) => {
      const mat = new THREE.MeshBasicMaterial({ map: gridLabelTexture(text), transparent: true, depthWrite: false, depthTest: false, opacity: 0, toneMapped: false });
      this.labelMats[board].push(mat);
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 1.1, z);
      m.renderOrder = 3;
      this.labels.add(m);
    };
    for (const board of ['own', 'enemy']) {
      for (let i = 0; i < 10; i++) {
        const p = cellToWorld(board, i, 0);
        const q = cellToWorld(board, 0, i);
        label(board, 'ABCDEFGHIJ'[i], p.x, -50 - 4.5);
        label(board, String(i + 1), BOARD_CENTER[board] - 50 - 4.5, q.z);
      }
    }
    this.scene.add(this.labels);
    this.labelOpacity = { own: 0, enemy: 0 };
    this.labelTarget = { own: 0, enemy: 0 };
  }

  /** Flotte de parade à l'accueil. */
  spawnReviewFleet() {
    this.review = [];
    const entries = [
      ['carrier', -82, 8, 1.2], ['battleship', -46, 34, 1.2], ['cruiser', -30, -24, 1.2],
      ['destroyer', -110, 42, 1.2], ['destroyer', 6, 10, 1.2],
    ];
    for (const [type, x, z, angle] of entries) {
      const model = createShipModel(type);
      model.group.position.set(x, 0, z);
      model.group.rotation.y = angle;
      this.scene.add(model.group);
      this.review.push({ group: model.group, x, z, angle });
    }
  }

  hideReviewFleet() {
    for (const r of this.review) this.scene.remove(r.group);
    this.review = [];
  }

  showReviewFleet() {
    if (!this.review.length) this.spawnReviewFleet();
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  orbitCamera() { this.cameraState.mode = 'orbit'; this.cameraState.t = 1; }

  setView(name, duration = 1.7) {
    const c = this.cameraState;
    const v = VIEWS[name];
    const fit = Math.max(1, 1.62 / Math.min(this.camera.aspect, 1.62));
    c.from = this.camera.position.clone();
    c.fromLook = c.look.clone();
    c.to = new THREE.Vector3(v.pos[0], v.pos[1] * fit, v.pos[2] * fit);
    c.toLook = new THREE.Vector3(...v.look);
    c.t = 0;
    c.duration = duration;
    c.mode = 'move';
    this.view = name;
  }

  showBoards(own, enemy) {
    this.ocean.showBoards(own, enemy);
    this.labelTarget = { own, enemy };
  }

  pick(clientX, clientY, board) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    return worldToCell(board, hit);
  }

  addShip(board, ship, { sunk = false } = {}) {
    const model = createShipModel(ship.type);
    const { center, angle } = placementOf(board, ship);
    model.group.position.copy(center);
    model.group.rotation.y = angle;
    this.scene.add(model.group);
    const entry = { ...model, ship, center, angle, sinking: 0, sunk, phase: Math.random() * 6 };
    this.ships[board].set(ship.type, entry);
    if (sunk) {
      entry.sinking = SINK_DURATION_S;
      model.group.visible = false;
    } else {
      this.decals.shipWash(center.x, center.z, angle, model.length, model.beam);
    }
    return entry;
  }

  removeShip(board, type) {
    const e = this.ships[board].get(type);
    if (e) this.scene.remove(e.group);
    this.ships[board].delete(type);
  }

  setGhost(ship) {
    if (this.ghost) this.scene.remove(this.ghost.group);
    this.ghost = null;
    if (!ship) return;
    const model = createShipModel(ship.type);
    const { center, angle } = placementOf('own', ship);
    model.group.position.copy(center);
    model.group.rotation.y = angle;
    this.scene.add(model.group);
    this.ghost = { ...model, center, angle, phase: 0 };
  }

  rebuildWash() {
    this.decals.clear();
    for (const board of ['own', 'enemy']) {
      for (const e of this.ships[board].values()) {
        if (!e.sinking) this.decals.shipWash(e.center.x, e.center.z, e.angle, e.length, e.beam);
      }
    }
  }

  clearBoards() {
    for (const board of ['own', 'enemy']) {
      for (const type of [...this.ships[board].keys()]) this.removeShip(board, type);
      this.ocean.cells.clear(board);
    }
    this.markers.clear();
    this.particles.clearFires();
    this.fires = { own: [], enemy: [] };
    this.setGhost(null);
    this.decals.clear();
  }

  tintCell(board, x, y, color, alpha) { this.ocean.cells.set(board, x, y, color, alpha); }

  /** Bouée de marquage : blanche pour un coup à l'eau, sinon le feu suffit. */
  addMissMarker(board, x, y) {
    const pos = cellToWorld(board, x, y);
    const buoy = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.52, 1.5, 8),
      new THREE.MeshStandardMaterial({ color: 0xdfe4e4, roughness: 0.5, emissive: 0x3a3e40 }),
    );
    buoy.position.copy(pos);
    buoy.userData = { bob: Math.random() * 6, x: pos.x, z: pos.z };
    this.markers.add(buoy);
  }

  addFire(board, x, y, { silent = false } = {}) {
    const pos = cellToWorld(board, x, y);
    const fire = this.particles.addFire(() => ({ x: pos.x, y: 1.6 + waveHeight(pos.x, pos.z, this.time), z: pos.z }), { rate: silent ? 16 : 24, radius: 1.1, scale: 1.45 });
    fire.cell = { x, y };
    this.fires[board].push(fire);
    this.decals.oil(pos.x, pos.z, 6);
    return fire;
  }

  /** Canon → impact. `onImpact` déclenche le son et la mise à jour de l'interface. */
  fireShell(fromBoard, toBoard, x, y, result, onImpact) {
    const to = cellToWorld(toBoard, x, y);
    const ships = [...this.ships[fromBoard].values()].filter((e) => !e.sinking);
    let from;
    if (ships.length) {
      const e = ships[Math.floor(Math.random() * ships.length)];
      from = e.muzzle.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), e.angle).add(e.center);
    } else {
      from = new THREE.Vector3(BOARD_CENTER[fromBoard], 5, 0);
    }
    const dir = to.clone().sub(from).normalize();
    this.particles.muzzleFlash(from, dir.clone().setY(0.45).normalize());
    this.shells.push({
      from, to, age: 0, height: 48 + from.distanceTo(to) * 0.16, result, toBoard, onImpact, last: from.clone(),
    });
  }

  impact(shell) {
    const { to, result } = shell;
    if (result === 'miss') {
      this.particles.splash(to);
      this.shake = Math.max(this.shake, 0.25);
    } else {
      this.particles.explosion(to.clone().setY(2), result === 'sunk' ? 1.5 : 1);
      this.flash.position.copy(to).setY(8);
      this.flash.intensity = result === 'sunk' ? 26000 : 14000;
      this.shake = Math.max(this.shake, result === 'sunk' ? 1.5 : 0.9);
    }
    shell.onImpact?.();
  }

  sink(board, ship, { instant = false } = {}) {
    const e = this.ships[board].get(ship.type) ?? this.addShip(board, ship);
    if (instant) {
      e.sinking = SINK_DURATION_S;
      e.group.visible = false;
    } else if (!e.sinking) {
      e.sinking = 0.001;
      e.group.visible = true;
      for (const c of shipCells(ship)) {
        const p = cellToWorld(board, c.x, c.y);
        this.particles.explosion(p.clone().setY(2), 0.8);
      }
    }
    // Les feux du navire s'éteignent quand l'épave disparaît.
    const cells = new Set(shipCells(ship).map((c) => `${c.x},${c.y}`));
    const fires = this.fires[board].filter((f) => cells.has(`${f.cell.x},${f.cell.y}`));
    if (instant) fires.forEach((f) => this.particles.removeFire(f));
    else setTimeout(() => fires.forEach((f) => this.particles.removeFire(f)), (SINK_DURATION_S - 1) * 1000);
    this.fires[board] = this.fires[board].filter((f) => !fires.includes(f));
    const c = placementOf(board, ship).center;
    this.decals.oil(c.x, c.z, 14);
  }

  updateShip(e, t, dt) {
    const { group, center, angle, length } = e;
    const dx = Math.sin(angle) * length * 0.42;
    const dz = Math.cos(angle) * length * 0.42;
    const nx = Math.cos(angle) * 2;
    const nz = -Math.sin(angle) * 2;
    const yc = waveHeight(center.x, center.z, t);
    const pitch = Math.atan2(waveHeight(center.x + dx, center.z + dz, t) - waveHeight(center.x - dx, center.z - dz, t), length * 0.84);
    const roll = Math.atan2(waveHeight(center.x + nx, center.z + nz, t) - waveHeight(center.x - nx, center.z - nz, t), 4);
    let sink = 0;
    let extraPitch = 0;
    let extraRoll = 0;
    if (e.sinking) {
      e.sinking = Math.min(SINK_DURATION_S, e.sinking + dt);
      const p = e.sinking / SINK_DURATION_S;
      sink = -p * p * 16;
      extraPitch = p * p * 0.42;
      extraRoll = p * 0.3;
      if (p >= 1) group.visible = false;
    }
    group.position.set(center.x, yc * 0.75 + sink, center.z);
    group.rotation.set(-(pitch * 0.7) - extraPitch, angle, roll * 0.5 + extraRoll, 'YXZ');
  }

  updateCamera(dt) {
    const c = this.cameraState;
    if (c.mode === 'orbit') {
      c.orbit += dt * 0.012;
      const r = 128;
      const a = Math.sin(c.orbit) * 0.3 - 0.25;
      this.camera.position.set(-70 + Math.sin(a) * r, 8.5 + Math.sin(this.time * 0.11) * 0.9, 24 + Math.cos(a) * r);
      c.look.set(-118 + Math.sin(a) * r * 0.82, 15, 0);
    } else if (c.t < 1) {
      c.t = Math.min(1, c.t + dt / c.duration);
      const e = ease(c.t);
      this.camera.position.lerpVectors(c.from, c.to, e);
      c.look.lerpVectors(c.fromLook, c.toLook, e);
    }
    const swayX = Math.sin(this.time * 0.31) * 0.5;
    const swayY = Math.sin(this.time * 0.23) * 0.35;
    this.shake *= Math.exp(-dt * 4.2);
    const s = this.shake;
    this.camera.lookAt(
      c.look.x + swayX + (Math.random() - 0.5) * s * 1.6,
      c.look.y + swayY + (Math.random() - 0.5) * s * 1.6,
      c.look.z,
    );
  }

  adaptQuality(dt) {
    this.frames++;
    this.fpsWindow += dt;
    if (this.fpsWindow < 3) return;
    const fps = this.frames / this.fpsWindow;
    this.lastFps = fps;
    this.frames = 0;
    this.fpsWindow = 0;
    if (fps < 26 && this.pixelRatio > 0.7) {
      this.pixelRatio = Math.max(0.7, this.pixelRatio - 0.2);
      this.lowQuality = true;
      this.renderer.setPixelRatio(this.pixelRatio);
      this.renderer.shadowMap.autoUpdate = false;
      this.bloom.enabled = this.pixelRatio > 0.8;
      this.resize();
    }
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.time += dt;
    const t = this.time;
    this.ocean.update(t, dt, this.camera);
    this.particles.update(t, dt, this.lowQuality);

    for (const r of this.review) {
      r.group.position.y = waveHeight(r.x, r.z, t) * 0.7;
      r.group.rotation.x = Math.sin(t * 0.5 + r.x) * 0.012;
      r.group.rotation.z = Math.sin(t * 0.38 + r.z) * 0.015;
    }
    for (const board of ['own', 'enemy']) for (const e of this.ships[board].values()) this.updateShip(e, t, dt);
    if (this.ghost) this.updateShip(this.ghost, t, dt);
    for (const b of this.markers.children) {
      b.position.y = waveHeight(b.userData.x, b.userData.z, t) + 0.5;
      b.rotation.z = Math.sin(t * 1.3 + b.userData.bob) * 0.12;
    }

    this.shells = this.shells.filter((s) => {
      s.age += dt;
      const k = Math.min(1, s.age / SHOT_FLIGHT_S);
      const p = s.from.clone().lerp(s.to, k);
      p.y += Math.sin(k * Math.PI) * s.height;
      this.particles.trail(p);
      this.particles.trail(p.clone().lerp(s.last, 0.5));
      s.last.copy(p);
      if (k >= 1) {
        this.impact(s);
        return false;
      }
      return true;
    });

    this.flash.intensity *= Math.exp(-dt * 7);
    for (const board of ['own', 'enemy']) {
      this.labelOpacity[board] += (this.labelTarget[board] - this.labelOpacity[board]) * Math.min(1, dt * 3);
      for (const m of this.labelMats[board]) m.opacity = this.labelOpacity[board] * 0.82;
    }

    this.updateCamera(dt);
    this.finish.uniforms.uTime.value = t % 10;
    this.composer.render(dt);
    this.adaptQuality(dt);
  }
}

export { CELL };
