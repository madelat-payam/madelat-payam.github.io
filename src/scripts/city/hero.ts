import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  InstancedMesh,
  LineBasicMaterial,
  MeshLambertMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

import { loadCities, GEOM_STRIDE, WORLD_RADIUS, type MetricInfo } from './cityData';
import {
  sampleRamp,
  windowT,
  THEME_DEFAULT_RAMP,
  RAMP_NAMES,
  type RampName,
  type ThemeName,
} from './colormaps';
import { METRICS, DEFAULT_METRIC, type MetricKey } from './metrics';

gsap.registerPlugin(ScrollTrigger);

const DARK = new Color(0x0a0e16);
const LIGHT = new Color(0xf2f1ec);
// Grid line color per theme, lerped with the background so the grid stays
// legible in both. At the old near-black values it vanished on the dark bg.
const DARK_GRID = new Color(0x2b3550);
const LIGHT_GRID = new Color(0xcfccc3);
const GRID_SPAN = WORLD_RADIUS * 2.4;

// One curated shot per city: the framing the camera passes through when that
// city's box is centered. These are the approved stills from the render rounds.
// The two tall cities sit low and look up (small height, higher lookY) so
// their towers loom.
interface CamKey {
  az: number; // azimuth around the city, radians
  height: number; // camera height in world units
  radius: number; // distance from the city center
  lookY: number; // height the camera aims at (higher looks up the towers)
}

const CAM_KEYS: CamKey[] = [
  { az: 0.6, height: 24, radius: 42, lookY: 6 }, // c0
  { az: 0.95, height: 26, radius: 41, lookY: 6 }, // c1
  { az: 1.28, height: 27, radius: 40, lookY: 6 }, // c2
  { az: 1.6, height: 20, radius: 35, lookY: 9 }, // c3, tall: low and looming
  { az: 2.55, height: 15, radius: 32, lookY: 9 }, // c4, tall: low, island on the diagonal
];

// Catmull-Rom through the keys, one field at a time, ends clamped. The path
// passes exactly through every approved shot with continuous velocity; the
// linear blend it replaces had a velocity corner at each key, which is a fair
// part of why the old motion read as mechanical.
function splineKey(field: keyof CamKey, u: number): number {
  const n = CAM_KEYS.length;
  const at = (k: number) => CAM_KEYS[Math.max(0, Math.min(n - 1, k))][field];
  const i = Math.max(0, Math.min(n - 2, Math.floor(u)));
  const t = u - i;
  const p0 = at(i - 1);
  const p1 = at(i);
  const p2 = at(i + 1);
  const p3 = at(i + 2);
  return 0.5 * (2 * p1 + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

// The view orbit (right-drag, the way Rhino turns a viewport) adds these on
// top of the scripted shot: an azimuth turn and a height change per pixel of
// drag, with the height clamped so a drag can neither tunnel under the ground
// plane nor sail over the top. The offsets persist, so the scroll tour simply
// continues from wherever the visitor left the view turned.
const ORBIT_PER_PX = 0.005; // radians per pixel of horizontal drag
const RAISE_PER_PX = 0.12; // world units per pixel of vertical drag
const HEIGHT_MIN = 5;
const HEIGHT_MAX = 60;

// What the hero hands back so the page can build the metric and palette controls
// and their legend, and switch either at runtime.
export interface HeroController {
  metrics: Record<MetricKey, MetricInfo>;
  metricKeys: MetricKey[];
  rampNames: RampName[];
  activeMetric: () => MetricKey;
  activeRamp: () => RampName;
  setMetric: (key: MetricKey) => void;
  setRamp: (name: RampName) => void;
}

/**
 * Builds the scrolling city and owns its own render loop. `content` is the
 * scrollable element whose scroll progress drives the city-to-city morph. The
 * returned controller lets the page change the color metric and palette.
 */
export async function initHero(canvas: HTMLCanvasElement, content: HTMLElement): Promise<HeroController> {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const bg = new Color().copy(DARK);
  const fog = new Fog(bg.getHex(), 30, 98);
  const scene = new Scene();
  scene.background = bg;
  scene.fog = fog;

  const camera = new PerspectiveCamera(50, 1, 0.1, 400);

  const data = await loadCities(import.meta.env.BASE_URL);
  const count = data.count;
  const cities = data.geom.length;

  const geometry = new BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0); // base sits on the ground plane
  const mesh = new InstancedMesh(geometry, new MeshLambertMaterial(), count);
  scene.add(mesh);

  // A raking key light plus fill gives each block shaded faces, so buildings
  // read as separate forms rather than a flat field of one color.
  const key = new DirectionalLight(0xffffff, 0.7);
  key.position.set(28, 60, 18);
  scene.add(key);
  scene.add(new AmbientLight(0xffffff, 0.62));

  const grid = new GridHelper(GRID_SPAN, 30);
  grid.position.y = 0.01;
  // One theme-driven color for the whole grid instead of the baked two-tone, so
  // paintTheme can keep it readable as the background shifts.
  const gridMaterial = grid.material as LineBasicMaterial;
  gridMaterial.vertexColors = false;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.5;
  scene.add(grid);

  let activeMetric: MetricKey = DEFAULT_METRIC;
  // null means follow the theme default; a visitor's pick pins a ramp.
  let userRamp: RampName | null = null;
  const rampFor = (theme: ThemeName): RampName => userRamp ?? THEME_DEFAULT_RAMP[theme];

  const dummy = new Object3D();
  const color = new Color();

  // Write one city into the instance buffers for a scroll position p in
  // [0, cities-1]. Buildings never slide from one layout to the next, which would
  // make unrelated footprints cross and pile up; each block instead does a
  // vertical sink-swap-rise in place. What makes the change read as smooth is
  // that the blocks do NOT all do it at once. If they did, the whole city passed
  // through zero height together and the frame went briefly empty (a black beat
  // on the dark theme). Here each block's sink-swap-rise is delayed by how far it
  // sits from the center, so the next city blooms out from the middle while the
  // old one still stands at the edges. The scene is never empty. See waveProgress
  // for the per-block timing and the two dials that shape it.
  let lastApplied = -1;
  function applyProgress(p: number): void {
    const seg = Math.max(0, Math.min(cities - 2, Math.floor(p)));
    const f = p - seg;
    const theme = themeName();
    const ramp = rampFor(theme);
    const oldGeom = data.geom[seg];
    const newGeom = data.geom[seg + 1];
    const oldT = data.metricT[activeMetric][seg];
    const newT = data.metricT[activeMetric][seg + 1];
    for (let i = 0; i < count; i++) {
      const o = i * GEOM_STRIDE;
      // The block's own transition progress, delayed by its radius. The phase is
      // read from the outgoing city so it holds steady across this whole
      // transition, whichever city the block is currently drawn from.
      const fi = waveProgress(f, Math.hypot(oldGeom[o], oldGeom[o + 1]), i);
      const g = fi < 0.5 ? oldGeom : newGeom;
      const t = fi < 0.5 ? oldT : newT;
      // Height eases to zero and back with cos squared (a soft bottom, no
      // bounce); the footprint pinches to nothing only right around the block's
      // own swap, so its plate never jumps visibly between the two layouts.
      const env = Math.cos(Math.PI * fi) ** 2;
      const foot = footprintEnv(fi);
      dummy.position.set(g[o], 0, g[o + 1]);
      dummy.rotation.set(0, g[o + 4], 0);
      dummy.scale.set(
        Math.max(g[o + 2] * foot, 0.001),
        Math.max(g[o + 5] * env, 0.001),
        Math.max(g[o + 3] * foot, 0.001),
      );
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, sampleRamp(ramp, windowT(t[i], theme), color));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    lastApplied = p;
  }

  // Camera state. camU is the damped position along the shot path. Unlike the
  // morph index it has no rest plateaus: the morph rests so a settled city sits
  // under each box, while the camera keeps traveling through the whole gap.
  // Splitting the two was the core of the camera rework. When the camera also
  // rested, every transition packed a swing, a drop, and a push into the same
  // short window as the wave; the stills were approved and the live motion was
  // not, and that freeze-then-lurch rhythm was the difference. The Vector3 pair
  // is a second, faster damping stage that soaks up the idle drift and any
  // orbit-drag without lagging the scroll.
  let camU = 0;
  let camReady = false;
  const camPos = new Vector3();
  const camLook = new Vector3();
  const shotPos = new Vector3();
  const shotLook = new Vector3();

  // View-orbit offsets, written by the right-drag handlers below.
  let userAz = 0;
  let userH = 0;

  // The scripted shot plus the visitor's orbit offsets. The sine terms are an
  // idle drift, small enough to sit below attention, so the frame stays alive
  // between wheel notches instead of freezing solid.
  function cameraShot(u: number, sec: number): CamKey {
    const height = splineKey('height', u) + Math.sin(sec * 0.19) * 0.4 + userH;
    return {
      az: splineKey('az', u) + Math.sin(sec * 0.31) * 0.01 + userAz,
      height: Math.max(HEIGHT_MIN, Math.min(HEIGHT_MAX, height)),
      radius: splineKey('radius', u),
      lookY: splineKey('lookY', u),
    };
  }

  function placeCamera(shot: CamKey, mx: number, my: number, snap: boolean): void {
    shotPos.set(Math.cos(shot.az) * shot.radius, shot.height, Math.sin(shot.az) * shot.radius);
    shotLook.set(0, shot.lookY, 0);
    if (snap || !camReady) {
      camPos.copy(shotPos);
      camLook.copy(shotLook);
      camReady = true;
    } else {
      camPos.lerp(shotPos, 0.12);
      camLook.lerp(shotLook, 0.12);
    }
    camera.position.set(camPos.x + mx * 4, camPos.y - my * 2, camPos.z);
    camera.lookAt(camLook);
  }

  function paintTheme(mix: number): void {
    bg.copy(DARK).lerp(LIGHT, mix);
    fog.color.copy(bg);
    gridMaterial.color.copy(DARK_GRID).lerp(LIGHT_GRID, mix);
  }

  function resize(): void {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  resize();

  let targetTheme = readTheme();
  const onThemeChange = new MutationObserver(() => {
    targetTheme = readTheme();
    repaint(); // theme changes the color window and possibly the default ramp
  });
  onThemeChange.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // A metric or palette change does not move the scroll, so force the next draw
  // to rewrite the instance colors even when progress has not moved.
  function repaint(): void {
    lastApplied = -1;
  }

  // Rhino-style view orbit: hold the right button and drag. Horizontal turns
  // the city, vertical raises or lowers the eye. The offsets persist until the
  // visitor turns the view back; the scroll tour keeps working throughout, just
  // seen from their angle. Panels, the header, the controls, and links keep
  // their normal right-click; the open canvas around them is the orbit surface,
  // and the browser menu is suppressed only when the press actually dragged.
  // Wired outside the reduced-motion split because a hand-driven turn is the
  // visitor's own motion, not ours; camDirty lets the static path repaint.
  let dragging = false;
  let dragMoved = false;
  let dragX = 0;
  let dragY = 0;
  let camDirty = false;

  function orbitSurface(target: EventTarget | null): boolean {
    return !(target instanceof Element && target.closest('.panel, .bar, .hero-ui, a, button'));
  }

  addEventListener('pointerdown', (e) => {
    if (e.button !== 2 || !orbitSurface(e.target)) return;
    dragging = true;
    dragMoved = false;
    dragX = e.clientX;
    dragY = e.clientY;
  });
  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragX;
    const dy = e.clientY - dragY;
    dragX = e.clientX;
    dragY = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true;
    userAz += dx * ORBIT_PER_PX;
    // Drag up moves the eye up. The raw offset is unbounded; cameraShot clamps
    // the applied height, so a long drag never winds up a huge hidden debt.
    userH = Math.max(
      HEIGHT_MIN - HEIGHT_MAX,
      Math.min(HEIGHT_MAX, userH - dy * RAISE_PER_PX),
    );
    camDirty = true;
    document.documentElement.style.cursor = 'grabbing';
  });
  const endDrag = (): void => {
    dragging = false;
    document.documentElement.style.cursor = '';
  };
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);
  addEventListener('contextmenu', (e) => {
    if (dragMoved && orbitSurface(e.target)) e.preventDefault();
  });

  const controller: HeroController = {
    metrics: data.metrics,
    metricKeys: METRICS.map((m) => m.key),
    rampNames: RAMP_NAMES,
    activeMetric: () => activeMetric,
    activeRamp: () => rampFor(themeName()),
    setMetric: (metricKey) => {
      activeMetric = metricKey;
      repaint();
    },
    setRamp: (name) => {
      userRamp = name;
      repaint();
    },
  };

  if (reduce) {
    // Calm, static view: the first city, fixed framing, no scroll-driven motion
    // and no idle drift. The view orbit still works, because that motion is the
    // visitor's own hand. Metric, palette, and theme changes apply immediately.
    const renderStatic = (): void => {
      if (lastApplied < 0) applyProgress(0);
      paintTheme(readTheme());
      placeCamera(cameraShot(0, 0), 0, 0, true);
      camDirty = false;
      renderer.render(scene, camera);
    };
    renderStatic();
    addEventListener('resize', renderStatic);
    new MutationObserver(renderStatic).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    // The controllers set lastApplied = -1 and the orbit sets camDirty; a light
    // loop turns either into a redraw.
    const tick = (): void => {
      if (lastApplied < 0 || camDirty) renderStatic();
      requestAnimationFrame(tick);
    };
    tick();
    return controller;
  }

  const scroll = { progress: 0 };
  ScrollTrigger.create({
    trigger: content,
    start: 'top top',
    end: 'bottom bottom',
    scrub: 1,
    onUpdate: (self) => {
      scroll.progress = self.progress;
    },
  });

  // Smooth, inertial page scroll. A mouse wheel jumps the page a notch at a time,
  // which reads as rigid; Lenis virtualizes wheel and touch and eases the real
  // scroll position instead, so the whole page floats. ScrollTrigger reads that
  // eased position, so the city floats with the text. Reduced-motion visitors
  // return on the calm path above and never reach here, so they keep the plain,
  // immediate scroll. Driven from gsap's ticker so there is one clock.
  injectLenisCss();
  const lenis = new Lenis({ lerp: 0.09, anchors: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);

  const mouse = { x: 0, y: 0 };
  // The raw pointer feeds a smoothed copy read by the camera, so the parallax
  // trails the hand instead of twitching with it. Frozen during an orbit drag;
  // one hand movement should not steer two things at once.
  const mouseS = { x: 0, y: 0 };
  addEventListener('pointermove', (e) => {
    if (dragging) return;
    mouse.x = e.clientX / innerWidth - 0.5;
    mouse.y = e.clientY / innerHeight - 0.5;
  });

  // Anchor the morph to the page's sections so a city is settled whenever a box
  // is centered and the change happens in the scroll between the boxes. Measured
  // from the live layout and refreshed on resize. With no sections to read (a
  // different page shape), the cities spread evenly across the scroll instead.
  const sections = Array.from(content.querySelectorAll<HTMLElement>('.section'));
  let anchors = computeAnchors();
  addEventListener('resize', () => {
    anchors = computeAnchors();
  });

  function computeAnchors(): Anchor[] {
    const range = document.documentElement.scrollHeight - innerHeight;
    if (sections.length === 0 || range <= 0) {
      return Array.from({ length: cities }, (_, i) => ({ p: cities > 1 ? i / (cities - 1) : 0, city: i }));
    }
    const y = scrollY;
    return sections.map((el, i) => {
      const rect = el.getBoundingClientRect();
      const center = rect.top + y + rect.height / 2 - innerHeight / 2;
      return { p: Math.max(0, Math.min(1, center / range)), city: Math.min(i, cities - 1) };
    });
  }

  let current = 0;
  let themeMix = targetTheme;

  function frame(): void {
    // The morph is anchored to the page sections (computeAnchors), so a city is
    // settled whenever a box is centered and it only changes in the scroll
    // between boxes. current trails the target so scroll jitter never snaps.
    const target = morphFromAnchors(scroll.progress, anchors);
    current += (target - current) * 0.1;
    if (lastApplied < 0 || Math.abs(current - lastApplied) > 0.002) applyProgress(current);

    const sec = performance.now() / 1000;
    camU += (camPathFromAnchors(scroll.progress, anchors) - camU) * 0.06;
    mouseS.x += (mouse.x - mouseS.x) * 0.05;
    mouseS.y += (mouse.y - mouseS.y) * 0.05;
    placeCamera(cameraShot(camU, sec), mouseS.x, mouseS.y, false);

    themeMix += (targetTheme - themeMix) * 0.08;
    paintTheme(themeMix);

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  frame();
  return controller;
}

function readTheme(): number {
  return document.documentElement.dataset.theme === 'light' ? 1 : 0;
}

function themeName(): ThemeName {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

// The handful of style rules Lenis needs, injected once so the smooth-scroll
// setup stays contained in this module. Lenis toggles the lenis-* classes on the
// root element; these rules let it own the scroll without the browser's own
// smooth-scroll fighting it.
function injectLenisCss(): void {
  if (document.getElementById('lenis-css')) return;
  const style = document.createElement('style');
  style.id = 'lenis-css';
  style.textContent =
    'html.lenis,html.lenis body{height:auto}' +
    '.lenis.lenis-smooth{scroll-behavior:auto!important}' +
    '.lenis.lenis-smooth [data-lenis-prevent]{overscroll-behavior:contain}' +
    '.lenis.lenis-stopped{overflow:hidden}' +
    '.lenis.lenis-smooth iframe{pointer-events:none}';
  document.head.appendChild(style);
}

// A morph anchor: the scroll progress at which a section is centered, and the
// city that should be settled and standing there.
interface Anchor {
  p: number;
  city: number;
}

// Map scroll progress (0..1) to a morph index by resting on the anchor cities
// and only moving between them. Near an anchor the index sits flat on that city,
// so the box centered there is read over a settled skyline; between two anchors
// it eases from one city to the next with a smootherstep. REST is the share of
// each gap held on the leaving and the arriving city, so the change happens in
// the middle of the gap, between the boxes. Two anchors on the same city just
// hold, so no morph happens where consecutive sections share a city.
const REST = 0.25;

function morphFromAnchors(s: number, anchors: Anchor[]): number {
  if (anchors.length === 0) return 0;
  if (s <= anchors[0].p) return anchors[0].city;
  const last = anchors[anchors.length - 1];
  if (s >= last.p) return last.city;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (s < a.p || s > b.p) continue;
    if (a.city === b.city) return a.city;
    const span = b.p - a.p;
    const tStart = a.p + REST * span;
    const tEnd = b.p - REST * span;
    if (s <= tStart) return a.city;
    if (s >= tEnd) return b.city;
    return a.city + (b.city - a.city) * smoother((s - tStart) / (tEnd - tStart));
  }
  return last.city;
}

// The camera's path parameter from the same anchors, but with no rest plateaus:
// piecewise linear from anchor to anchor. The morph rests so a settled city sits
// under each box; the camera instead spends the whole gap traveling, which
// halves its peak speed and removes the freeze-then-lurch rhythm. camU's damping
// rounds the corners this piecewise map has at the anchors.
function camPathFromAnchors(s: number, anchors: Anchor[]): number {
  if (anchors.length === 0) return 0;
  if (s <= anchors[0].p) return anchors[0].city;
  const last = anchors[anchors.length - 1];
  if (s >= last.p) return last.city;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (s < a.p || s > b.p) continue;
    if (a.city === b.city) return a.city;
    return a.city + (b.city - a.city) * ((s - a.p) / (b.p - a.p));
  }
  return last.city;
}

// Footprint size across a transition. Full for most of a block's own morph, so
// it reads as sinking straight down, and eased to nothing only within PINCH of
// its swap at fi = 0.5, which hides the instant its layout changes. PINCH is a
// half-width in morph units; smaller keeps footprints full longer.
const PINCH = 0.1;
function footprintEnv(fi: number): number {
  return smoother(Math.min(1, Math.abs(fi - 0.5) / PINCH));
}

// Per-block transition progress for the wave. A block's own sink-swap-rise takes
// WAVE_WIDTH of the whole transition; the remaining time staggers the start by
// radius, so the block at the center changes first and the one at WAVE_RADIUS
// changes last. WAVE_JITTER scatters each block's start a little off that clean
// radius, so the moving front reads as a soft organic band rather than a hard
// ring. Because only a band is ever mid-change, the core and the edge always
// stand: the whole city never disappears and the frame never blanks. f is the
// transition progress in [0,1]; radius is the block's distance from center in
// world units; i is its index, used only for a stable per-block offset.
const WAVE_WIDTH = 0.5;
const WAVE_RADIUS = WORLD_RADIUS;
const WAVE_JITTER = 0.35;
function waveProgress(f: number, radius: number, i: number): number {
  const radial = Math.min(1, radius / WAVE_RADIUS);
  const phase = Math.max(0, Math.min(1, radial + (hash01(i) - 0.5) * WAVE_JITTER));
  return Math.max(0, Math.min(1, (f - phase * (1 - WAVE_WIDTH)) / WAVE_WIDTH));
}

// A stable pseudo-random value in [0,1) from an integer index, for the wave
// jitter. The usual sine-hash: good enough to scatter start times, and it needs
// no state or table.
function hash01(i: number): number {
  const x = Math.sin(i * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

// Perlin's smootherstep: zero first and second derivatives at both ends, so a
// transition starts and stops without a visible kink.
function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
