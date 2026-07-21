// Live version of the CV masthead banner: the San Francisco blueprint city as
// a real-time wireframe with a slow cinematic drift, replacing the static
// render once it has loaded and painted. The static PNG stays in the page as
// the instant first paint and as the whole of the experience for reduced
// motion, small screens, and no-WebGL; this module is only ever imported when
// none of those apply, so the import itself is the code split point.
//
// The scene deliberately reuses the hero's data contract (the nine-float
// massing record) and its carbon pricing, but not its renderer: the banner is
// an x-ray drawing, not a lit model. Every box contributes its twelve edges to
// one merged line list per color, drawn without a depth test so far fabric
// shows through near fabric and overlapping strokes accumulate, which is what
// gives the drawing its density near the horizon. The top 3.5 percent of
// blocks by embodied carbon switch to the accent color and get a filled roof
// cap, same rule as the static render.

import {
  BufferGeometry,
  Color,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  BoxGeometry,
  EdgesGeometry,
} from 'three';

import { CLASS_COEFF } from '../city/metrics';

// The locked shot from banner-render-recipe.md: azimuth 52 degrees, camera
// 1153.4 m out at 95 m height, aimed at a point 205 m over the center, 52
// degree vertical fov, heights exaggerated 2.7x, near plane at 25 m so the
// closest fabric slices open instead of filling the frame. Verified against
// the shipped PNGs by image registration; every probed deviation scored worse.
const AZ = (52 * Math.PI) / 180;
const DIST = 1153.4;
const CAM_H = 95;
const TGT_H = 205;
const FOV = 52;
const VEXAG = 2.7;
const NEAR = 25;

// The static render's frame. The live camera reproduces the CSS cover crop of
// that image (background-position: center 30%), so the swap from PNG to live
// is a change of medium, not of framing, at any masthead size.
const IMAGE_ASPECT = 3600 / 1300;
const COVER_Y = 0.3;

const ACCENT_RANK = 0.965;
const RAW_STRIDE = 9;

// Palettes locked in session 6, same table as the static renderer.
const THEMES = {
  dark: { bg: 0x0a0e16, ink: [0.56, 0.84, 1.0], accent: [1.0, 0.66, 0.28] },
  light: { bg: 0xf2f1ec, ink: [0.06, 0.24, 0.25], accent: [0.74, 0.28, 0.1] },
} as const;

// Line opacities. Ink stays translucent so strokes stack toward saturation in
// the dense band; accent runs nearer opaque so the towers read as marked, not
// merely colored.
const INK_ALPHA = 0.5;
const ACCENT_ALPHA = 0.75;

// Drift: three slow sines on azimuth, height, and distance, with periods that
// share no small common multiple, so the motion never reads as a loop. The
// amplitude eases in from zero over the first seconds, which makes the first
// live frame exactly the locked shot the PNG showed.
const DRIFT_AZ = (0.9 * Math.PI) / 180;
const DRIFT_H = 5;
const DRIFT_DIST = 0.012;
const RAMP_S = 6;

export async function initBanner(canvas: HTMLCanvasElement): Promise<void> {
  const base = import.meta.env.BASE_URL;
  const buffer = await fetch(`${base}data/cities/san_francisco.bin`).then((r) => r.arrayBuffer());
  const raw = new Float32Array(buffer);
  const n = raw.length / RAW_STRIDE;

  // Carbon rank within the city, the hero's pricing on the banner's data.
  const carbon = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = i * RAW_STRIDE;
    carbon[i] = raw[r + 6] * raw[r + 7] * CLASS_COEFF[Math.round(raw[r + 8])];
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => carbon[a] - carbon[b]);
  const rank = new Float32Array(n);
  for (let k = 0; k < n; k++) rank[order[k]] = n > 1 ? k / (n - 1) : 0;

  // Merge per color on the CPU. At 2310 blocks this is one small pass at load;
  // instancing would save memory the scene does not miss and cost a second
  // draw path for the roofs.
  const unitEdges = new EdgesGeometry(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  const edge = unitEdges.getAttribute('position');
  const inkPos: number[] = [];
  const accentPos: number[] = [];
  const roofPos: number[] = [];
  const m = new Matrix4();
  const p = new Vector3();
  const s = new Vector3();
  const v = new Vector3();
  const quat = new Quaternion();
  const euler = new Euler();
  const roofCorners = [
    [-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 1, 0.5], [-0.5, 1, 0.5],
  ] as const;
  for (let i = 0; i < n; i++) {
    const r = i * RAW_STRIDE;
    p.set(raw[r], 0, raw[r + 1]);
    euler.set(0, raw[r + 4], 0);
    s.set(raw[r + 2], raw[r + 5] * VEXAG, raw[r + 3]);
    m.compose(p, quat.setFromEuler(euler), s);
    const accent = rank[i] >= ACCENT_RANK;
    const out = accent ? accentPos : inkPos;
    for (let k = 0; k < edge.count; k++) {
      v.fromBufferAttribute(edge, k).applyMatrix4(m);
      out.push(v.x, v.y, v.z);
    }
    if (accent) {
      const c = roofCorners.map(([x, y, z]) => v.set(x, y, z).applyMatrix4(m).toArray());
      roofPos.push(...c[0], ...c[1], ...c[2], ...c[0], ...c[2], ...c[3]);
    }
  }
  unitEdges.dispose();

  const scene = new Scene();
  const bg = new Color();
  scene.background = bg;

  const inkMat = new LineBasicMaterial({ transparent: true, opacity: INK_ALPHA, depthTest: false });
  const accentMat = new LineBasicMaterial({ transparent: true, opacity: ACCENT_ALPHA, depthTest: false });
  // The caps run just short of opaque; the static render's caps carry a touch
  // of transparency, and matching it keeps the PNG-to-live swap quiet.
  const roofMat = new MeshBasicMaterial({ side: DoubleSide, depthTest: false, transparent: true, opacity: 0.88 });

  const asLines = (pos: number[], mat: LineBasicMaterial): LineSegments => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pos, 3));
    return new LineSegments(g, mat);
  };
  // Draw order is the occlusion model here: ink, then accent lines, then the
  // filled caps on top, like ink layers on a drawing.
  scene.add(asLines(inkPos, inkMat));
  scene.add(asLines(accentPos, accentMat));
  const roofGeom = new BufferGeometry();
  roofGeom.setAttribute('position', new Float32BufferAttribute(roofPos, 3));
  scene.add(new Mesh(roofGeom, roofMat));

  function paintTheme(): void {
    const theme = THEMES[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];
    bg.set(theme.bg);
    // The palette triplets are sRGB, the recipe's own values; without saying
    // so, setRGB would read them as linear and every color would render pale.
    inkMat.color.setRGB(theme.ink[0], theme.ink[1], theme.ink[2], SRGBColorSpace);
    accentMat.color.setRGB(theme.accent[0], theme.accent[1], theme.accent[2], SRGBColorSpace);
    roofMat.color.setRGB(theme.accent[0], theme.accent[1], theme.accent[2], SRGBColorSpace);
  }
  paintTheme();
  new MutationObserver(paintTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const camera = new PerspectiveCamera(FOV, IMAGE_ASPECT, NEAR, 30000);

  // Emulate the CSS cover crop: hold the image's own aspect on the camera and
  // let setViewOffset carve the masthead's box out of that virtual frame, top
  // offset at the same 30% the stylesheet uses. Without this, a wide masthead
  // would re-frame the scene instead of cropping it, and the PNG-to-live swap
  // would visibly jump.
  function resize(): void {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    if (w / h >= IMAGE_ASPECT) {
      const fullH = w / IMAGE_ASPECT;
      camera.setViewOffset(w, fullH, 0, (fullH - h) * COVER_Y, w, h);
    } else {
      const fullW = h * IMAGE_ASPECT;
      camera.setViewOffset(fullW, h, (fullW - w) / 2, 0, w, h);
    }
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const look = new Vector3();
  function placeCamera(sec: number): void {
    // smootherstep on the ramp so the drift starts from stillness
    const t = Math.min(1, sec / RAMP_S);
    const ramp = t * t * t * (t * (t * 6 - 15) + 10);
    const az = AZ + ramp * DRIFT_AZ * Math.sin((sec * 2 * Math.PI) / 47);
    const h = CAM_H + ramp * DRIFT_H * Math.sin((sec * 2 * Math.PI) / 61 + 1.3);
    const d = DIST * (1 + ramp * DRIFT_DIST * Math.sin((sec * 2 * Math.PI) / 83 + 2.1));
    camera.position.set(Math.cos(az) * d, h, Math.sin(az) * d);
    camera.lookAt(look.set(0, TGT_H, 0));
  }

  // The loop runs only while the masthead is actually on screen; scrolled into
  // the document proper, the banner costs nothing.
  let visible = true;
  let rafId = 0;
  const started = performance.now();
  function frame(): void {
    placeCamera((performance.now() - started) / 1000);
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(frame);
  }
  new IntersectionObserver((entries) => {
    const now = entries[0].isIntersecting;
    if (now === visible) return;
    visible = now;
    if (visible) {
      frame();
    } else {
      cancelAnimationFrame(rafId);
    }
  }).observe(canvas);

  // First frame before the caller fades the canvas in over the PNG.
  placeCamera(0);
  renderer.render(scene, camera);
  frame();
}
