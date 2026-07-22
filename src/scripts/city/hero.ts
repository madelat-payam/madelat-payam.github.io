import {
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  HemisphereLight,
  LineBasicMaterial,
  Mesh,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShadowMaterial,
  Vector3,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

import { loadCities, WORLD_RADIUS, type MetricInfo } from './cityData';
import {
  defaultRamp,
  RAMP_NAMES,
  type RampName,
  type ThemeName,
} from './colormaps';
import { METRICS, DEFAULT_METRIC, type MetricKey } from './metrics';
import { buildGroundLayers, GROUND_RENDER_LAYER, type GroundLayers } from './groundLayers';
import { buildFootprintCities } from './footprints';

gsap.registerPlugin(ScrollTrigger);

const DARK = new Color(0x0a0e16);
const LIGHT = new Color(0xf2f1ec);
// Grid line color per theme, lerped with the background so the grid stays
// legible in both. At the old near-black values it vanished on the dark bg.
const DARK_GRID = new Color(0x2b3550);
const LIGHT_GRID = new Color(0xcfccc3);
// Lighting colors per theme, lerped in paintTheme like the background and grid.
// Sky and ground feed the hemisphere ambient (tops catch the sky, undersides sink
// toward the ground); the key is the sun. Kept moderate so a lit face still shows
// its carbon-ramp hue instead of washing out to white.
const DARK_SKY = new Color(0x9fb4d6);
const DARK_GROUND = new Color(0x0b0f18);
const DARK_KEY = new Color(0xffe9cf);
const LIGHT_SKY = new Color(0xfbf4ea);
const LIGHT_GROUND = new Color(0xcdc7ba);
const LIGHT_KEY = new Color(0xfff1d8);
// Base light intensities, and how much brighter the dark theme is lit. The dark
// background needs more light for the ramp colors to carry; the light theme is already
// bright, so it stays at base. paintTheme lerps between the two by the theme mix.
const HEMI_BASE = 0.5;
const KEY_BASE = 0.6;
const DARK_BRIGHT = 1.8;
const GRID_SPAN = WORLD_RADIUS * 2.4;

// Phones take a lighter hero, gated on the same viewport width the page CSS uses for
// its mobile layout: the footprint set is capped to the largest buildings and the
// ground layers come off. The cap keeps the skyline-defining stock and drops the small
// footprints that would not read at a phone's scale. It is a provisional value, meant
// to be retuned against a real device in the mobile pass, not a measured limit.
const MOBILE_BREAKPOINT = '(max-width: 760px)';
const MOBILE_MAX_BUILDINGS = 6000;

// One curated shot per city: the framing the camera passes through when that
// city's box is centered. These are the approved stills from the render rounds.
// The two tall cities sit low and close, so the real-height towers (after the
// VERTICAL_EXAGGERATION fix) loom instead of reading as low blocks seen from above.
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
  { az: 1.6, height: 11, radius: 27, lookY: 6 }, // c3, tall: dropped low and close so the towers loom
  { az: 2.55, height: 8, radius: 23, lookY: 5 }, // c4, tall: low and close, island on the diagonal
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
  // A phone gets the capped footprint set and no ground layers (see the constants
  // above). Read once at build; the hero does not re-tier if the window is resized.
  const isPhone = matchMedia(MOBILE_BREAKPOINT).matches;

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const bg = new Color().copy(DARK);
  const fog = new Fog(bg.getHex(), 30, 98);
  const scene = new Scene();
  scene.background = bg;
  scene.fog = fog;

  const camera = new PerspectiveCamera(50, 1, 0.1, 400);

  // cityData still loads the massing records, but only two of its outputs are used now:
  // the per-city world scale (which lands both the footprints and the ground layers on
  // the same ground) and the metric domains for the legend. The real geometry and color
  // come from the footprint renderer below, so the boxed geom and rank arrays go undrawn.
  const data = await loadCities(import.meta.env.BASE_URL);
  const cities = data.geom.length;

  // The real extruded footprints, one merged mesh per city, driven by setMorph each
  // frame and recolored by setColor on demand. On a phone the set is capped to the
  // largest buildings. They stay on the default render layer, so they feed the GTAO pass.
  const footprints = await buildFootprintCities(
    import.meta.env.BASE_URL,
    data.scale,
    isPhone ? { maxBuildings: MOBILE_MAX_BUILDINGS } : {},
  );
  scene.add(footprints.object);

  // Lighting. A hemisphere ambient (sky above, ground below) gives every block a
  // top-to-bottom gradient so forms read without washing the color to white; a
  // raking key stands in for the sun; a weak counter-fill keeps the shadowed sides
  // from going dead; a filtered shadow grounds the towers on the light theme; and ambient
  // occlusion darkens where forms meet, which is what carries the depth on the dark
  // theme, where a cast shadow on the near-black ground cannot. Light colors track
  // the theme in paintTheme.
  const hemi = new HemisphereLight(0xffffff, 0xffffff, HEMI_BASE);
  scene.add(hemi);

  const key = new DirectionalLight(0xffffff, KEY_BASE);
  key.position.set(34, 44, 22);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  const shadowExtent = WORLD_RADIUS * 1.4;
  Object.assign(key.shadow.camera, { left: -shadowExtent, right: shadowExtent, top: shadowExtent, bottom: -shadowExtent, near: 1, far: 240 });
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);

  const fill = new DirectionalLight(0xffffff, 0.15);
  fill.position.set(-26, 20, -20);
  scene.add(fill);

  renderer.shadowMap.enabled = true;
  // three 0.185 deprecates PCFSoftShadowMap and silently renders PCFShadowMap in its
  // place (logging a warning), so ask for PCFShadowMap directly: the result is identical
  // and the console stays clean. Each footprint mesh sets its own cast/receive flags in
  // footprints.ts, and carries a depth material so its cast shadow follows the sink.
  renderer.shadowMap.type = PCFShadowMap;

  // A near-invisible plane catches the shadow so the towers sit on something,
  // while the scene keeps its floating look wherever no shadow falls.
  const shadowGround = new Mesh(new PlaneGeometry(GRID_SPAN * 1.6, GRID_SPAN * 1.6), new ShadowMaterial({ opacity: 0.33 }));
  shadowGround.rotation.x = -Math.PI / 2;
  shadowGround.receiveShadow = true;
  scene.add(shadowGround);

  // Ambient occlusion runs as a post pass, so the frame goes through a composer
  // rather than a direct render (draw, below). GTAO darkens contacts from geometry
  // alone, so the depth reads on both themes, including where the cast shadow cannot
  // register on the dark theme's near-black ground.
  // GTAO reads the whole scene into a normal/depth buffer to find contacts. The flat
  // ground layers would poison that: a plane spanning the ground makes a concave water
  // inlet read as fully occluded and turn black. This clone stays on the default render
  // layer, so the AO buffer sees the massing alone; the real camera below also draws the
  // ground layer. syncAoCamera keeps the clone on the real camera every frame.
  const gtaoCamera = camera.clone();
  gtaoCamera.layers.set(0);

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(devicePixelRatio, 2));
  composer.setSize(innerWidth, innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  const gtao = new GTAOPass(scene, gtaoCamera, innerWidth, innerHeight);
  // Radius in world units: the scene spans ~26 and blocks are a few units, so a
  // radius near 2 catches building-to-building and base contact without graying whole
  // faces; blendIntensity above 1 keeps the occlusion dark enough to read on dark.
  gtao.updateGtaoMaterial({
    radius: 2, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false,
  });
  gtao.blendIntensity = 1.35;
  composer.addPass(gtao);
  composer.addPass(new OutputPass());

  function draw(): void {
    composer.render();
  }

  const grid = new GridHelper(GRID_SPAN, 30);
  grid.position.y = 0.01;
  // One theme-driven color for the whole grid instead of the baked two-tone, so
  // paintTheme can keep it readable as the background shifts.
  const gridMaterial = grid.material as LineBasicMaterial;
  gridMaterial.vertexColors = false;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.5;
  scene.add(grid);

  // The road/green/water layers for every city, drawn flat under the massing at each
  // city's own world scale. setMorph cross-fades the resting city's ground with the
  // morph; paint tracks the theme. The visible camera has to see their render layer;
  // the AO clone above deliberately does not.
  let layers: GroundLayers | null = null;
  if (!isPhone) {
    layers = await buildGroundLayers(import.meta.env.BASE_URL, data.scale);
    scene.add(layers.object);
    camera.layers.enable(GROUND_RENDER_LAYER);
  }

  let activeMetric: MetricKey = DEFAULT_METRIC;
  // null means follow the metric's default ramp for the current theme; a visitor's pick
  // pins one ramp across every metric and theme until they change it.
  let userRamp: RampName | null = null;
  // Carbon defaults to the green-to-red impact ramp on both themes; height and floor
  // area fall back to the theme's perceptual default. defaultRamp encodes that split.
  const rampFor = (metric: MetricKey, theme: ThemeName): RampName =>
    userRamp ?? defaultRamp(metric, theme);

  // The footprint renderer bakes per-building vertex colors, so color is set once per
  // change instead of rewritten every frame the way the boxed hero did. A metric,
  // palette, or theme change calls this; the scroll loop below does no color work.
  function recolor(): void {
    const theme = themeName();
    footprints.setColor(activeMetric, rampFor(activeMetric, theme), theme);
  }

  // A control or theme change does not move the scroll, so the reduced-motion path
  // (which only draws on demand) needs a nudge to repaint. The live loop draws every
  // frame and ignores this flag.
  let staticDirty = false;

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

  // Keep the AO camera clone on the real camera. Same view and projection; only the
  // render-layer mask differs, so GTAO samples the massing while the beauty pass draws
  // the ground layers too.
  function syncAoCamera(): void {
    gtaoCamera.position.copy(camera.position);
    gtaoCamera.quaternion.copy(camera.quaternion);
    gtaoCamera.updateMatrixWorld();
  }

  function paintTheme(mix: number): void {
    bg.copy(DARK).lerp(LIGHT, mix);
    fog.color.copy(bg);
    gridMaterial.color.copy(DARK_GRID).lerp(LIGHT_GRID, mix);
    hemi.color.copy(DARK_SKY).lerp(LIGHT_SKY, mix);
    hemi.groundColor.copy(DARK_GROUND).lerp(LIGHT_GROUND, mix);
    key.color.copy(DARK_KEY).lerp(LIGHT_KEY, mix);
    fill.color.copy(DARK_SKY).lerp(LIGHT_SKY, mix);
    // Dark lit brighter than light so the ramp colors carry on the ink-navy background.
    const litFactor = DARK_BRIGHT + (1 - DARK_BRIGHT) * mix;
    hemi.intensity = HEMI_BASE * litFactor;
    key.intensity = KEY_BASE * litFactor;
    layers?.paint(mix);
  }

  function resize(): void {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    gtaoCamera.aspect = camera.aspect;
    gtaoCamera.updateProjectionMatrix();
    composer.setSize(innerWidth, innerHeight);
  }
  addEventListener('resize', resize);
  resize();

  let targetTheme = readTheme();
  const onThemeChange = new MutationObserver(() => {
    targetTheme = readTheme();
    // A theme swaps the per-theme color window and can swap a metric's default ramp, so
    // rebake the colors here; the eased background lerp is handled in the frame loop.
    recolor();
    staticDirty = true;
  });
  onThemeChange.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

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

  // impact is offered as a fifth swatch even though colormaps keeps it out of the
  // perceptual set: it is carbon's default, and surfacing it lets a visitor pin it, or
  // pin a perceptual ramp over it, while the active swatch tracks the metric otherwise.
  const pickerRamps: RampName[] = [...RAMP_NAMES, 'impact'];

  const controller: HeroController = {
    metrics: data.metrics,
    metricKeys: METRICS.map((m) => m.key),
    rampNames: pickerRamps,
    activeMetric: () => activeMetric,
    activeRamp: () => rampFor(activeMetric, themeName()),
    setMetric: (metricKey) => {
      activeMetric = metricKey;
      recolor();
      staticDirty = true;
    },
    setRamp: (name) => {
      userRamp = name;
      recolor();
      staticDirty = true;
    },
  };

  // The first color bake, before either path draws. Without it every building would
  // render at the zeroed vertex color the renderer starts each geometry with.
  recolor();

  if (reduce) {
    // Calm, static view: the first city settled, fixed framing, no scroll-driven
    // motion and no idle drift. The view orbit still works, because that motion is the
    // visitor's own hand. Metric, palette, and theme changes apply immediately.
    const renderStatic = (): void => {
      footprints.setMorph(0);
      layers?.setMorph(0);
      paintTheme(readTheme());
      placeCamera(cameraShot(0, 0), 0, 0, true);
      syncAoCamera();
      camDirty = false;
      staticDirty = false;
      draw();
    };
    renderStatic();
    addEventListener('resize', renderStatic);
    // A control change flips staticDirty and the theme observer above also rebakes
    // color; the orbit sets camDirty. A light loop turns either into a redraw.
    const tick = (): void => {
      if (staticDirty || camDirty) renderStatic();
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
    // setMorph only sets two uniforms and toggles visibility on the one or two live
    // cities, so it is cheap enough to drive unconditionally every frame.
    footprints.setMorph(current);
    layers?.setMorph(current);

    const sec = performance.now() / 1000;
    camU += (camPathFromAnchors(scroll.progress, anchors) - camU) * 0.06;
    mouseS.x += (mouse.x - mouseS.x) * 0.05;
    mouseS.y += (mouse.y - mouseS.y) * 0.05;
    placeCamera(cameraShot(camU, sec), mouseS.x, mouseS.y, false);
    syncAoCamera();

    themeMix += (targetTheme - themeMix) * 0.08;
    paintTheme(themeMix);

    draw();
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

// Perlin's smootherstep: zero first and second derivatives at both ends, so a
// transition starts and stops without a visible kink.
function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
