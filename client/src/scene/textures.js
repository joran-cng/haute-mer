import * as THREE from 'three';

const canvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
};
const srgbTexture = (c, repeat = false) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
};
const rand = (a, b) => a + Math.random() * (b - a);

function speckle(ctx, w, h, count, alpha) {
  for (let i = 0; i < count; i++) {
    const v = Math.random() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${v},${v},${v},${Math.random() * alpha})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, rand(1, 3), rand(1, 3));
  }
}

/** Coque : u = longueur, v = hauteur. La flottaison est calée sur `waterline` (0..1 depuis la quille). */
export function hullTexture({ base = '#646d72', waterline = 0.32 }) {
  const W = 2048;
  const H = 512;
  const [c, ctx] = canvas(W, H);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, W, H);
  const lineY = H * (1 - waterline);
  // Tôles : panneaux légèrement désaccordés.
  for (let x = 0; x < W; x += 74) {
    for (let y = 0; y < lineY; y += 46) {
      ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * 0.05})`;
      ctx.fillRect(x, y, 74, 46);
      ctx.strokeStyle = 'rgba(10,14,16,.16)';
      ctx.strokeRect(x + 0.5, y + 0.5, 74, 46);
    }
  }
  speckle(ctx, W, H, 9000, 0.09);
  // Coulures de rouille sous les dalots.
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * W;
    const y = rand(0, lineY * 0.45);
    const len = rand(40, 240);
    const g = ctx.createLinearGradient(0, y, 0, y + len);
    g.addColorStop(0, `rgba(78,42,22,${rand(0.28, 0.6)})`);
    g.addColorStop(1, 'rgba(78,42,22,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, rand(1.5, 6), len);
  }
  // Salissures horizontales près de la flottaison.
  const stain = ctx.createLinearGradient(0, lineY - 100, 0, lineY);
  stain.addColorStop(0, 'rgba(22,22,18,0)');
  stain.addColorStop(1, 'rgba(22,22,18,.5)');
  ctx.fillStyle = stain;
  ctx.fillRect(0, lineY - 100, W, 100);
  // Bande noire de flottaison, puis antifouling rouge oxyde.
  ctx.fillStyle = '#121416';
  ctx.fillRect(0, lineY - 12, W, 22);
  ctx.fillStyle = '#4a1d16';
  ctx.fillRect(0, lineY + 10, W, H - lineY);
  speckle(ctx, W, H, 2000, 0.05);
  return srgbTexture(c);
}

export function deckTexture({ base = '#5a6063', lines = 8 } = {}) {
  const [c, ctx] = canvas(1024, 1024);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 1024, 1024);
  speckle(ctx, 1024, 1024, 30000, 0.1);
  ctx.strokeStyle = 'rgba(0,0,0,.22)';
  for (let i = 0; i < lines; i++) {
    const p = (i / lines) * 1024;
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(1024, p); ctx.moveTo(p, 0); ctx.lineTo(p, 1024); ctx.stroke();
  }
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
    ctx.beginPath();
    ctx.ellipse(Math.random() * 1024, Math.random() * 1024, rand(20, 110), rand(10, 60), Math.random() * 3, 0, 6.3);
    ctx.fill();
  }
  return srgbTexture(c, true);
}

export function flightDeckTexture() {
  // Proportions du pont d'envol (17 × 44 m environ) : deux cases de large.
  const W = 800;
  const sx = (v) => (v / 512) * W;
  const [c, ctx] = canvas(W, 2048);
  ctx.fillStyle = '#51575a';
  ctx.fillRect(0, 0, W, 2048);
  speckle(ctx, W, 2048, 64000, 0.1);
  // Traces de pneus sur la piste oblique d'appontage.
  for (let i = 0; i < 260; i++) {
    const v = rand(1000, 1960);
    const u = sx(330) - ((1960 - v) / 1060) * sx(150) + rand(-sx(70), sx(70));
    ctx.fillStyle = `rgba(8,8,8,${rand(0.05, 0.22)})`;
    ctx.fillRect(u, v, rand(2, 5), rand(60, 300));
  }
  // Ascenseurs et catapultes avant.
  ctx.strokeStyle = 'rgba(20,22,23,.55)';
  ctx.lineWidth = 4;
  for (const [x, y, w, h] of [[sx(440), 700, sx(60), 150], [sx(440), 1180, sx(60), 150], [sx(14), 1500, sx(60), 140]]) ctx.strokeRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(30,32,34,.8)';
  ctx.lineWidth = 3;
  for (const x of [sx(120), sx(250)]) { ctx.beginPath(); ctx.moveTo(x, 60); ctx.lineTo(x + sx(20), 560); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(232,226,204,.8)';
  ctx.lineWidth = 7;
  ctx.setLineDash([]);
  ctx.strokeRect(32, 24, W - 64, 2000);
  ctx.setLineDash([58, 42]);
  ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(sx(185), 80); ctx.lineTo(sx(185), 1040); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sx(330), 1960); ctx.lineTo(sx(180), 900); ctx.stroke();
  ctx.setLineDash([]);
  // Bords de la piste oblique.
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(sx(250), 1960); ctx.lineTo(sx(70), 880); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(sx(410), 1960); ctx.lineTo(sx(290), 920); ctx.stroke();
  ctx.strokeStyle = 'rgba(221,190,74,.8)';
  ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(sx(60), 620); ctx.lineTo(sx(440), 620); ctx.stroke();
  ctx.fillStyle = 'rgba(232,226,204,.9)';
  ctx.font = 'bold 190px "Barlow Condensed", sans-serif';
  ctx.save();
  ctx.translate(sx(330), 1850);
  ctx.fillText('62', -78, 0);
  ctx.restore();
  return srgbTexture(c);
}

/** Texte peint sur la coque ; le plan portant ce texte est retourné selon le bord. */
export function hullNumberTexture(text) {
  const [c, ctx] = canvas(256, 128);
  ctx.font = 'bold 104px "Barlow Condensed", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(224,226,222,.88)';
  ctx.fillText(text, 128, 66);
  const t = srgbTexture(c);
  return t;
}

export function gridLabelTexture(text) {
  const [c, ctx] = canvas(96, 96);
  ctx.font = '600 58px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,.8)';
  ctx.shadowBlur = 8;
  ctx.fillStyle = 'rgba(224,240,248,.95)';
  ctx.fillText(text, 48, 50);
  return srgbTexture(c);
}

/** Atlas 4×4 de bouffées fumée/flamme : formes irrégulières obtenues en cumulant des disques doux. */
export function puffAtlas() {
  const S = 128;
  const [c, ctx] = canvas(S * 4, S * 4);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const cx = col * S + S / 2;
      const cy = row * S + S / 2;
      for (let i = 0; i < 46; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = (Math.random() ** 1.5) * S * 0.28;
        const r = rand(S * 0.06, S * 0.2);
        const x = cx + Math.cos(a) * d;
        const y = cy + Math.sin(a) * d;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,.26)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Carte peinte en continu : R écume, G mazout, B ombre de contact. Couvre les deux plateaux. */
export class DecalMap {
  constructor() {
    const [c, ctx] = canvas(2080, 1040);
    this.canvas = c;
    this.ctx = ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 2080, 1040);
    ctx.globalCompositeOperation = 'lighter';
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.flipY = false; // z croissant = bas du canvas, comme dans le shader
  }

  toPx(x, z) { return [((x + 130) / 260) * 2080, ((z + 65) / 130) * 1040]; }

  blob(x, z, radius, [r, g, b], intensity = 1, stretch = 1, angle = 0) {
    const { ctx } = this;
    const [px, py] = this.toPx(x, z);
    const rad = radius * 8;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.scale(stretch, 1);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rad);
    gradient.addColorStop(0, `rgba(${r},${g},${b},${intensity})`);
    gradient.addColorStop(0.55, `rgba(${r},${g},${b},${intensity * 0.55})`);
    gradient.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    this.texture.needsUpdate = true;
  }

  /** Écume d'étrave et sillage calme autour d'un navire au mouillage. */
  shipWash(x, z, angle, length, beam) {
    const dx = Math.sin(angle);
    const dz = Math.cos(angle);
    const nx = dz;
    const nz = -dx;
    const stepCount = Math.ceil(length / 0.5);
    for (let i = 0; i <= stepCount; i++) {
      const f = i / stepCount - 0.5;
      const px = x + dx * f * length;
      const pz = z + dz * f * length;
      const taper = Math.min(1, (0.5 - Math.abs(f)) * 5 + 0.2);
      this.blob(px, pz, beam * 0.72 * taper + 0.3, [0, 0, 255], 0.09);
      for (const side of [-1, 1]) {
        const offset = (beam * 0.5 * taper + 0.18) * side;
        this.blob(px + nx * offset, pz + nz * offset, 0.62, [255, 0, 0], 0.075);
      }
    }
    this.blob(x + dx * length * 0.5, z + dz * length * 0.5, 1.1, [255, 0, 0], 0.35);
  }

  oil(x, z, size = 7) {
    for (let i = 0; i < 9; i++) {
      this.blob(x + rand(-size, size) * 0.7, z + rand(-size, size) * 0.7, rand(size * 0.2, size * 0.5), [0, 255, 0], 0.32, rand(1, 1.8), Math.random() * 3);
    }
  }

  clear() {
    const { ctx } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 2080, 1040);
    ctx.globalCompositeOperation = 'lighter';
    this.texture.needsUpdate = true;
  }
}
