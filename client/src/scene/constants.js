import * as THREE from 'three';

export const CELL = 10;
export const BOARD_CENTER = { own: -65, enemy: 65 };
export const SUN_DIRECTION = new THREE.Vector3(0.52, 0.105, -0.85).normalize();

export const cellToWorld = (board, x, y, out = new THREE.Vector3()) =>
  out.set(BOARD_CENTER[board] + (x - 4.5) * CELL, 0, (y - 4.5) * CELL);

export function worldToCell(board, point) {
  const x = Math.floor((point.x - BOARD_CENTER[board]) / CELL + 5);
  const y = Math.floor(point.z / CELL + 5);
  return x >= 0 && x < 10 && y >= 0 && y < 10 ? { x, y } : null;
}

// Houle : mêmes paramètres dans le vertex shader et dans waveHeight() pour faire flotter les navires.
// [direction x, direction z, amplitude, longueur d'onde]
export const WAVES = [
  [0.86, 0.5, 0.42, 74],
  [0.3, 0.95, 0.27, 47],
  [-0.56, 0.83, 0.15, 29],
  [0.97, -0.24, 0.09, 17],
];
const GRAVITY = 9.8;
export const waveK = WAVES.map(([, , , l]) => (2 * Math.PI) / l);
export const waveW = waveK.map((k) => Math.sqrt(GRAVITY * k) * 0.72);

export function waveHeight(x, z, t) {
  let y = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const [dx, dz, a] = WAVES[i];
    y += a * Math.sin(waveK[i] * (dx * x + dz * z) - waveW[i] * t);
  }
  return y;
}
