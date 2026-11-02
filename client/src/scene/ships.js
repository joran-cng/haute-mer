import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLEET, shipCells } from '../../../shared/game.js';
import { CELL, cellToWorld } from './constants.js';
import { deckTexture, flightDeckTexture, hullNumberTexture, hullTexture } from './textures.js';

const materials = {};

function getMaterials() {
  if (materials.hull) return materials;
  Object.assign(materials, {
    hull: new THREE.MeshStandardMaterial({ map: hullTexture({ base: '#7f898e' }), roughness: 0.62, metalness: 0.22 }),
    deck: new THREE.MeshStandardMaterial({ map: deckTexture(), roughness: 0.86, metalness: 0.1 }),
    flight: new THREE.MeshStandardMaterial({ map: flightDeckTexture(), roughness: 0.84, metalness: 0.08 }),
    paint: new THREE.MeshStandardMaterial({ color: 0x9aa5ab, roughness: 0.58, metalness: 0.25 }),
    paintDark: new THREE.MeshStandardMaterial({ color: 0x69727a, roughness: 0.64, metalness: 0.3 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x2a2e31, roughness: 0.46, metalness: 0.74 }),
    black: new THREE.MeshStandardMaterial({ color: 0x0d0f11, roughness: 0.75, metalness: 0.2 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0b1518, roughness: 0.1, metalness: 0.9, emissive: 0xffa64d, emissiveIntensity: 0.55 }),
    sub: new THREE.MeshStandardMaterial({ color: 0x2b3034, roughness: 0.52, metalness: 0.35 }),
    white: new THREE.MeshStandardMaterial({ color: 0xc8ccc8, roughness: 0.42, metalness: 0.1 }),
    lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 1.2, 0.8) }),
  });
  return materials;
}

/** Empile les géométries par matériau et les fusionne : un navire = une poignée d'appels de rendu. */
class Builder {
  constructor() { this.parts = new Map(); }

  add(material, geometry, matrix) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (matrix) g.applyMatrix4(matrix);
    if (!this.parts.has(material)) this.parts.set(material, []);
    this.parts.get(material).push(g);
  }

  box(material, w, h, d, x, y, z, { ry = 0, rx = 0, rz = 0 } = {}) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1),
    );
    this.add(material, new THREE.BoxGeometry(w, h, d), m);
  }

  cyl(material, rTop, rBottom, h, x, y, z, { rx = 0, rz = 0, seg = 12 } = {}) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz)), new THREE.Vector3(1, 1, 1),
    );
    this.add(material, new THREE.CylinderGeometry(rTop, rBottom, h, seg), m);
  }

  finish() {
    const group = new THREE.Group();
    for (const [material, geometries] of this.parts) {
      const clean = geometries.map((g) => {
        const out = new THREE.BufferGeometry();
        out.setAttribute('position', g.getAttribute('position'));
        out.setAttribute('normal', g.getAttribute('normal'));
        out.setAttribute('uv', g.getAttribute('uv'));
        return out;
      });
      const mesh = new THREE.Mesh(mergeGeometries(clean), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }
}

/** Coque lissée par sections : étrave élancée, tonture et voûte arrière. */
function hullGeometry(b, { length: L, beam, freeboard, draft, sheer = 0.35, bowFlare = 0.2 }) {
  const stations = 44;
  const ring = 10;
  const positions = [];
  const uvs = [];
  const indices = [];
  const deckEdge = [];
  const halfWidth = (t) => {
    const stern = 0.8 + 0.2 * Math.min(1, t / 0.2) ** 0.7;
    const bow = t > 0.5 ? 1 - ((t - 0.5) / 0.5) ** 2.15 : 1;
    return (beam / 2) * stern * Math.max(bow, 0.001);
  };
  const vTotal = draft + freeboard + sheer * 2;
  for (const side of [-1, 1]) {
    const base = positions.length / 3;
    for (let i = 0; i <= stations; i++) {
      const t = i / stations;
      const bowF = Math.max(0, (t - 0.62) / 0.38);
      const z = (t - 0.5) * L;
      const w = halfWidth(t);
      const top = freeboard + sheer * bowF * bowF * 1.6 + sheer * 0.25 * (1 - t) ** 3;
      const bottom = -draft * (1 - bowF ** 3 * 0.72) * (1 - (Math.max(0, 0.12 - t) / 0.12) ** 2 * 0.4);
      for (let j = 0; j <= ring; j++) {
        const s = j / ring;
        const y = bottom + (top - bottom) * s;
        const x = w * (1 - (1 - s) ** 3.2) * (1 + bowFlare * bowF * s);
        positions.push(side * x, y, z + bowF ** 2.4 * s * 1.6);
        uvs.push(t, (y + draft) / vTotal);
      }
      if (side === 1) {
        deckEdge.push({
          x: w * (1 + bowFlare * bowF), y: top, z: z + bowF ** 2.4 * 1.6, t,
        });
      }
    }
    const row = ring + 1;
    for (let i = 0; i < stations; i++) {
      for (let j = 0; j < ring; j++) {
        const a = base + i * row + j;
        const quad = [a, a + row, a + 1, a + 1, a + row, a + row + 1];
        indices.push(...(side === -1 ? quad : [quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]]));
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  b.add(getMaterials().hull, g);

  // Pont : bande entre les deux livets, légèrement bombée.
  const dp = [];
  const duv = [];
  const di = [];
  deckEdge.forEach((e, i) => {
    dp.push(-e.x, e.y, e.z, 0, e.y + beam * 0.03, e.z, e.x, e.y, e.z);
    const v = (e.t * L) / 16;
    duv.push(0, v, (beam / 16) / 2, v, beam / 16, v);
    if (i < deckEdge.length - 1) {
      const a = i * 3;
      di.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
    }
  });
  const deck = new THREE.BufferGeometry();
  deck.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
  deck.setAttribute('uv', new THREE.Float32BufferAttribute(duv, 2));
  deck.setIndex(di);
  deck.computeVertexNormals();
  b.add(getMaterials().deck, deck);

  // Tableau arrière.
  const stern = deckEdge[0];
  const tw = stern.x;
  const transom = new THREE.PlaneGeometry(tw * 2, stern.y + draft * 0.6);
  transom.rotateY(Math.PI);
  transom.translate(0, (stern.y - draft * 0.6) / 2, -L / 2 - 0.01);
  b.add(getMaterials().paintDark, transom);
  return deckEdge;
}

function hullNumber(group, text, L, freeboard, beam) {
  const mat = new THREE.MeshBasicMaterial({
    map: hullNumberTexture(text), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  });
  mat.color.setScalar(0.4);
  const size = Math.min(1.5, freeboard * 0.5);
  for (const side of [-1, 1]) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size * 2, size), mat);
    plane.position.set(side * (beam * 0.44), freeboard * 0.62, L * 0.27);
    plane.rotation.y = side * (Math.PI / 2 + 0.07);
    group.add(plane);
  }
}

function turret(b, m, x, y, z, { w = 1.9, barrels = 3, length = 3.6, facing = 1 } = {}) {
  b.cyl(m.paintDark, w * 0.55, w * 0.6, 0.3, x, y, z);
  b.box(m.paint, w, 0.62, w * 1.2, x, y + 0.42, z);
  b.box(m.paint, w * 0.82, 0.3, w * 0.9, x, y + 0.82, z + facing * -0.08);
  for (let i = 0; i < barrels; i++) {
    const off = ((i - (barrels - 1) / 2) * w) / (barrels + 0.3);
    b.cyl(m.steel, 0.075, 0.12, length, x + off, y + 0.5, z + facing * (length / 2 + w * 0.5), { rx: Math.PI / 2 + facing * 0.05, seg: 8 });
  }
}

function radarMast(b, m, x, y, z, h) {
  b.cyl(m.paintDark, 0.1, 0.2, h, x, y + h / 2, z, { seg: 6 });
  b.box(m.steel, 1.5, 0.08, 0.08, x, y + h * 0.72, z);
  b.box(m.steel, 0.9, 0.06, 0.06, x, y + h * 0.88, z);
  b.box(m.steel, 0.1, 0.5, 1.6, x, y + h * 0.56, z);
  b.cyl(m.white, 0.28, 0.28, 0.3, x, y + h + 0.1, z, { seg: 10 });
  b.cyl(m.steel, 0.02, 0.03, 1.6, x, y + h + 1, z, { seg: 4 });
  b.box(m.lamp, 0.09, 0.09, 0.09, x, y + h + 1.75, z);
}

function superstructure(b, m, x, y, z, w, h, d, { windows = true } = {}) {
  b.box(m.paint, w, h, d, x, y + h / 2, z);
  if (windows) b.box(m.glass, w + 0.04, h * 0.12, d + 0.04, x, y + h * 0.72, z);
}

function buildCarrier() {
  const m = getMaterials();
  const b = new Builder();
  // Deux cases de large (20 m) : coque de 11 m, pont d'envol de 17 m en surplomb.
  const L = 46;
  const BEAM = 11;
  const DW = 17;
  const dims = { length: L, beam: BEAM, freeboard: 3.4, draft: 1.6, sheer: 0.1, bowFlare: 0.3 };
  hullGeometry(b, dims);
  const deckY = 4.4;
  // Pont d'envol : UV appliqués sur la seule face supérieure via une plaque dédiée.
  b.box(m.paintDark, DW, 0.4, L * 0.95, 0, deckY, -0.5);
  const plate = new THREE.PlaneGeometry(DW, L * 0.95);
  plate.rotateX(-Math.PI / 2);
  plate.rotateY(Math.PI);
  plate.translate(0, deckY + 0.21, -0.5);
  b.add(m.flight, plate);
  // Encorbellements sous le pont, qui le relient à la coque.
  for (const [z, w] of [[14, 12.5], [4, 14.5], [-8, 15.5], [-17, 13.5]]) b.box(m.paintDark, w, 1.1, 5, 0, deckY - 0.8, z);
  // Îlot tribord, au ras du bord.
  const ix = DW / 2 - 1.3;
  b.box(m.paint, 2.2, 2.4, 9, ix, deckY + 1.4, -3);
  b.box(m.paint, 1.9, 1.2, 5.6, ix, deckY + 3.2, -3.3);
  b.box(m.glass, 1.94, 0.3, 5.64, ix, deckY + 3.4, -3.3);
  b.box(m.paintDark, 1.3, 0.6, 3.6, ix, deckY + 4.1, -3.8);
  b.cyl(m.steel, 0.7, 0.8, 1.4, ix + 0.05, deckY + 2.9, -7, { seg: 10 });
  radarMast(b, m, ix, deckY + 4.4, -2.6, 3);
  // Appareils parqués.
  const jet = new THREE.Shape();
  jet.moveTo(0, 1.05); jet.lineTo(0.14, 0.2); jet.lineTo(0.8, -0.4); jet.lineTo(0.8, -0.56); jet.lineTo(0.16, -0.32);
  jet.lineTo(0.14, -0.72); jet.lineTo(0.34, -0.9); jet.lineTo(-0.34, -0.9); jet.lineTo(-0.14, -0.72);
  jet.lineTo(-0.16, -0.32); jet.lineTo(-0.8, -0.56); jet.lineTo(-0.8, -0.4); jet.lineTo(-0.14, 0.2); jet.closePath();
  const parkJet = (x, z, heading) => {
    const g = new THREE.ExtrudeGeometry(jet, { depth: 0.12, bevelEnabled: false });
    g.rotateX(Math.PI / 2);
    g.scale(1.5, 1, 1.5);
    g.rotateY(heading);
    g.translate(x, deckY + 0.42, z);
    b.add(m.paint, g);
  };
  // Rangée en épi le long du bord bâbord, groupe à l'avant, appareils près de l'îlot.
  for (let i = 0; i < 8; i++) parkJet(-DW / 2 + 1.8 + (i % 2) * 1.2, 19 - i * 3.2, 0.6 + Math.PI);
  for (let i = 0; i < 3; i++) parkJet(1.5 + i * 2.2, 18.5 - (i % 2) * 1.2, Math.PI);
  for (const z of [-12, 6, 9.5]) parkJet(ix - 3, z, 0);
  const group = b.finish();
  hullNumber(group, '62', L, 3.4, BEAM);
  return { group, length: L, beam: DW, muzzle: new THREE.Vector3(0, 7, 0) };
}

function buildBattleship() {
  const m = getMaterials();
  const b = new Builder();
  const L = 36.5;
  hullGeometry(b, { length: L, beam: 5.6, freeboard: 1.7, draft: 1.25, sheer: 0.55 });
  const y = 1.72;
  turret(b, m, 0, y, 9.4, {});
  turret(b, m, 0, y + 0.72, 5.9, { barrels: 3, length: 3.1 });
  turret(b, m, 0, y, -11.4, { facing: -1 });
  superstructure(b, m, 0, y, 0.5, 3.5, 1.5, 7.5);
  b.box(m.paintDark, 2.8, 0.3, 6, 0, y + 1.65, 0.5);
  superstructure(b, m, 0, y + 1.8, 2.2, 2.3, 1.15, 2.8);
  superstructure(b, m, 0, y + 2.95, 2.3, 1.7, 0.9, 1.9);
  b.box(m.paint, 2.6, 0.12, 1.2, 0, y + 3.84, 2.5);
  radarMast(b, m, 0, y + 3.9, 2.1, 2.5);
  b.cyl(m.paintDark, 0.62, 0.74, 2.5, 0, y + 2.3, -1.9, { seg: 12 });
  b.cyl(m.black, 0.64, 0.64, 0.3, 0, y + 3.5, -1.9, { seg: 12 });
  superstructure(b, m, 0, y + 1.8, -3.4, 1.7, 0.8, 1.9);
  radarMast(b, m, 0, y + 2.5, -4.2, 1.5);
  for (const side of [-1, 1]) {
    for (const z of [3.5, 0.6, -2.3]) {
      b.box(m.paint, 0.72, 0.36, 0.95, side * 2, y + 0.2, z);
      b.cyl(m.steel, 0.04, 0.05, 1.2, side * 2.3, y + 0.33, z + 0.8, { rx: Math.PI / 2, seg: 6 });
      b.cyl(m.steel, 0.04, 0.05, 1.2, side * 2.1, y + 0.33, z + 0.8, { rx: Math.PI / 2, seg: 6 });
    }
    b.cyl(m.white, 0.26, 0.26, 2, side * 1.95, y + 1.7, -2.2, { rx: Math.PI / 2, seg: 8 });
  }
  const group = b.finish();
  hullNumber(group, 'R91', L, 1.7, 5.6);
  return { group, length: L, beam: 5.6, muzzle: new THREE.Vector3(0, 4, 13) };
}

function buildCruiser() {
  const m = getMaterials();
  const b = new Builder();
  const L = 27.5;
  hullGeometry(b, { length: L, beam: 4.3, freeboard: 1.6, draft: 1, sheer: 0.5 });
  const y = 1.62;
  turret(b, m, 0, y, 8.1, { w: 1.4, barrels: 2, length: 2.5 });
  turret(b, m, 0, y, -9.2, { w: 1.4, barrels: 2, length: 2.5, facing: -1 });
  for (let i = 0; i < 12; i++) b.box(m.steel, 0.55, 0.12, 0.55, -0.7 + (i % 4) * 0.46, y + 0.1, 5.2 - Math.floor(i / 4) * 0.56);
  superstructure(b, m, 0, y, 1.7, 2.8, 1.4, 4.6);
  superstructure(b, m, 0, y + 1.4, 2.4, 1.9, 1, 2.4);
  radarMast(b, m, 0, y + 2.4, 2, 2.4);
  superstructure(b, m, 0, y, -3.2, 2.4, 1.1, 3.8, { windows: false });
  b.cyl(m.paintDark, 0.42, 0.56, 1.7, 0, y + 1.9, -1.8, { seg: 10 });
  b.cyl(m.black, 0.44, 0.44, 0.22, 0, y + 2.8, -1.8, { seg: 10 });
  radarMast(b, m, 0, y + 1.1, -3.9, 1.6);
  b.box(m.paintDark, 0.04, 0.02, 2.4, 0, y + 0.03, -6.3);
  for (const side of [-1, 1]) b.cyl(m.white, 0.22, 0.22, 1.6, side * 1.5, y + 1.1, -1, { rx: Math.PI / 2, seg: 8 });
  const group = b.finish();
  hullNumber(group, 'D645', L, 1.6, 4.3);
  return { group, length: L, beam: 4.3, muzzle: new THREE.Vector3(0, 3, 9) };
}

function buildSubmarine() {
  const m = getMaterials();
  const b = new Builder();
  const L = 26;
  const R = 1.25;
  const profile = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const nose = t > 0.82 ? Math.sqrt(Math.max(0, 1 - ((t - 0.82) / 0.18) ** 2)) : 1;
    const tail = t < 0.3 ? (t / 0.3) ** 0.75 * 0.97 + 0.03 : 1;
    profile.push(new THREE.Vector2(R * nose * tail + 0.001, (t - 0.5) * L));
  }
  const body = new THREE.LatheGeometry(profile, 24);
  body.rotateX(Math.PI / 2);
  b.add(m.sub, body);
  b.box(m.sub, 1.05, 2, 4.4, 0, 1.8, 3.3);
  b.box(m.sub, 0.9, 0.4, 3.9, 0, 2.95, 3.3);
  for (const side of [-1, 1]) {
    b.box(m.sub, 2.6, 0.08, 1.2, side * 1.55, 2.1, 3.7);
    b.box(m.sub, 2.4, 0.08, 1.4, side * 1.3, 0, -12.2);
  }
  b.box(m.sub, 0.08, 3.1, 1.6, 0, 0, -12.2);
  b.cyl(m.steel, 0.05, 0.08, 1.4, 0, 3.6, 3.9, { seg: 6 });
  b.cyl(m.steel, 0.04, 0.05, 1, 0.2, 3.4, 3.2, { seg: 6 });
  b.box(m.black, 0.6, 0.1, 7, 0, R - 0.02, -3);
  const group = b.finish();
  return { group, length: L, beam: 2.6, muzzle: new THREE.Vector3(0, 3, 3) };
}

function buildDestroyer() {
  const m = getMaterials();
  const b = new Builder();
  const L = 18;
  hullGeometry(b, { length: L, beam: 3.1, freeboard: 1.15, draft: 0.72, sheer: 0.42 });
  const y = 1.17;
  turret(b, m, 0, y, 4.9, { w: 1, barrels: 1, length: 1.9 });
  superstructure(b, m, 0, y, 1.1, 1.9, 1.05, 3.3);
  superstructure(b, m, 0, y + 1.05, 1.6, 1.3, 0.72, 1.6);
  radarMast(b, m, 0, y + 1.77, 1.3, 1.7);
  b.cyl(m.paintDark, 0.32, 0.42, 1.2, 0, y + 1.1, -1.1, { seg: 10 });
  b.cyl(m.black, 0.33, 0.33, 0.16, 0, y + 1.75, -1.1, { seg: 10 });
  superstructure(b, m, 0, y, -2.5, 1.5, 0.7, 2, { windows: false });
  for (const side of [-1, 1]) b.cyl(m.steel, 0.13, 0.13, 1.8, side * 0.7, y + 0.2, -4.6, { rx: Math.PI / 2 - 0.05, seg: 8 });
  const group = b.finish();
  hullNumber(group, 'F71', L, 1.15, 3.1);
  return { group, length: L, beam: 3.1, muzzle: new THREE.Vector3(0, 2, 6) };
}

const BUILDERS = {
  carrier: buildCarrier,
  battleship: buildBattleship,
  cruiser: buildCruiser,
  submarine: buildSubmarine,
  destroyer: buildDestroyer,
};

const cache = {};

export function createShipModel(type) {
  cache[type] ??= BUILDERS[type]();
  const { group, length, beam, muzzle } = cache[type];
  return { group: group.clone(), length, beam, muzzle };
}

export const shipLabel = (type) => FLEET.find((s) => s.type === type)?.name ?? type;

/** Centre et cap d'un navire posé sur la grille. Le modèle pointe vers +z. */
export function placementOf(board, ship) {
  const cells = shipCells(ship);
  const first = cellToWorld(board, cells[0].x, cells[0].y);
  const last = cellToWorld(board, cells[cells.length - 1].x, cells[cells.length - 1].y);
  return { center: first.clone().add(last).multiplyScalar(0.5), angle: ship.dir === 'h' ? Math.PI / 2 : 0 };
}

export const CELL_SIZE = CELL;
