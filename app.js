import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const video    = document.getElementById('camera');
const canvas   = document.getElementById('scene');
const overlay  = document.getElementById('overlay');
const startBtn = document.getElementById('startBtn');
const statusEl = document.getElementById('status');
const iconPalm  = document.getElementById('iconPalm');
const iconPoint = document.getElementById('iconPoint');

function setStatus(msg) { statusEl.textContent = msg; }

// ---------------------------------------------------------------------------
// Gesture state shared between MediaPipe and the render loop
// ---------------------------------------------------------------------------
const GESTURE = { NONE: 'none', PALM: 'palm', POINT: 'point' };
const hand = {
  gesture: GESTURE.NONE, // debounced/stable gesture used by the app
  raw: GESTURE.NONE,     // per-frame raw classification
  candidate: GESTURE.NONE,
  candTime: 0,
  // Latest screen-pixel positions for palm centre and index fingertip
  // (latched: kept through brief detection dropouts).
  palm:  { x: 0, y: 0 },
  point: { x: 0, y: 0 },
  lastSeen: 0,
};

// Debounce raw detections so a few dropped frames don't reset everything.
// Engaging a gesture is quick; releasing one needs to persist longer.
function debounceGesture(dt) {
  const seen = (performance.now() - hand.lastSeen) < 400;
  const raw = seen ? hand.raw : GESTURE.NONE;
  if (raw === hand.candidate) {
    hand.candTime += dt;
  } else {
    hand.candidate = raw;
    hand.candTime = 0;
  }
  const need = (hand.candidate === GESTURE.NONE) ? 0.45 : 0.12;
  if (hand.candTime >= need) hand.gesture = hand.candidate;
}

// ---------------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------------
let renderer, scene, camera;
let normalButterfly, glassButterfly;

const FOCAL_DEPTH = 0;          // world plane the butterfly lives on
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -FOCAL_DEPTH);

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0); // transparent → camera feed shows through
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  scene = new THREE.Scene();

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 6);
  camera.lookAt(0, 0, 0);

  // Environment for nice glass reflections.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Lights (also help the opaque butterfly read well).
  const dir = new THREE.DirectionalLight(0xffffff, 2.0);
  dir.position.set(2, 4, 5);
  scene.add(dir);
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  normalButterfly = buildButterfly(false);
  glassButterfly  = buildButterfly(true);
  glassButterfly.group.visible = false;
  scene.add(normalButterfly.group);
  scene.add(glassButterfly.group);

  initParticles();

  resize();
  window.addEventListener('resize', resize);
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Butterfly model (loaded from butterfly/Butterfly_Model.obj)
// ---------------------------------------------------------------------------
// The OBJ has no materials, so we assign textures by hand. Measuring the 14
// groups, the big surfaces (polySurface 1, 6, 8, 13) are the four wing panels;
// everything else (centred on x≈0) is the body / antennae / legs.
const WING_RE = /polySurface(1|6|8|13)(?![0-9])/;

const MODEL_URL = './butterfly/Butterfly_Model.obj';
const TEX = {
  wingColor: './butterfly/Monarch_Wings_Color.png',
  wingAlpha: './butterfly/Monarch_Wings_Alpha.png',
  bodyColor: './butterfly/Body_Color.png',
};

let modelTemplate = null;   // parsed OBJ (THREE.Group) reused to build instances
let modelCenter = new THREE.Vector3();
let modelFit = 1;           // scale that normalises wingspan to ~2 world units

function loadTexture(loader, url, srgb) {
  return new Promise((res) => {
    loader.load(url, (t) => {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      res(t);
    }, undefined, () => res(null));
  });
}

let texWingColor, texWingAlpha, texBodyColor;

async function loadButterflyAssets() {
  const texLoader = new THREE.TextureLoader();
  const objLoader = new OBJLoader();
  const [obj, wc, wa, bc] = await Promise.all([
    new Promise((res, rej) => objLoader.load(MODEL_URL, res, undefined, rej)),
    loadTexture(texLoader, TEX.wingColor, true),
    loadTexture(texLoader, TEX.wingAlpha, false),
    loadTexture(texLoader, TEX.bodyColor, true),
  ]);
  modelTemplate = obj;
  texWingColor = wc; texWingAlpha = wa; texBodyColor = bc;

  const box = new THREE.Box3().setFromObject(obj);
  box.getCenter(modelCenter);
  const size = new THREE.Vector3();
  box.getSize(size);
  modelFit = 2.0 / Math.max(size.x, 1e-4); // normalise so NORMAL_SCALE*fit gives a nice size
}

function glassMaterial(isWing) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xbfe8ff,
    metalness: 0,
    roughness: 0.05,
    transmission: 1.0,
    thickness: 0.5,
    ior: 1.5,
    transparent: true,
    side: THREE.DoubleSide,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.4,
  });
  if (isWing && texWingAlpha) { m.alphaMap = texWingAlpha; m.alphaTest = 0.4; }
  return m;
}

function texturedMaterial(isWing) {
  if (isWing) {
    return new THREE.MeshStandardMaterial({
      map: texWingColor || null,
      alphaMap: texWingAlpha || null,
      transparent: !!texWingAlpha,
      alphaTest: texWingAlpha ? 0.4 : 0,
      side: THREE.DoubleSide,
      roughness: 0.6,
      metalness: 0.0,
    });
  }
  return new THREE.MeshStandardMaterial({
    map: texBodyColor || null,
    side: THREE.DoubleSide,
    roughness: 0.7,
    metalness: 0.0,
  });
}

// Build one butterfly instance (textured or glass) from the loaded template.
// Hierarchy: group(outer, animated) → oriented(stand upright, face camera)
//            → scaled(fit) → centred(origin at centroid) → {leftPivot,rightPivot,body}
function buildButterfly(isGlass) {
  const outer    = new THREE.Group();
  const oriented = new THREE.Group();
  const scaled   = new THREE.Group();
  const centred  = new THREE.Group();
  const leftPivot  = new THREE.Group();
  const rightPivot = new THREE.Group();
  const bodyGroup  = new THREE.Group();

  oriented.rotation.x = -Math.PI / 2; // model lies flat (top view) → stand it up
  scaled.scale.setScalar(modelFit);
  centred.position.set(-modelCenter.x, -modelCenter.y, -modelCenter.z);

  outer.add(oriented);
  oriented.add(scaled);
  scaled.add(centred);
  centred.add(leftPivot, rightPivot, bodyGroup);

  const meshes = [];
  modelTemplate.traverse((o) => { if (o.isMesh) meshes.push(o); });

  for (const src of meshes) {
    const isWing = WING_RE.test(src.name);
    const mesh = new THREE.Mesh(src.geometry, isGlass ? glassMaterial(isWing) : texturedMaterial(isWing));
    mesh.name = src.name;
    if (isWing) {
      src.geometry.computeBoundingBox();
      const bb = src.geometry.boundingBox;
      const cx = (bb.min.x + bb.max.x) / 2;
      (cx < 0 ? leftPivot : rightPivot).add(mesh);
    } else {
      bodyGroup.add(mesh);
    }
  }

  return { group: outer, rightPivot, leftPivot, bodyGroup, isGlass };
}

// ---------------------------------------------------------------------------
// Behaviour / motion
// ---------------------------------------------------------------------------
const STATE = {
  WANDER: 'wander',       // normal butterfly flying randomly
  TO_PALM: 'toPalm',      // flying toward palm centre
  MORPH_OUT: 'morphOut',  // normal butterfly shrinking 100% -> 0%
  MORPH_IN: 'morphIn',    // glass butterfly growing 0% -> 150%
  GLASS: 'glass',         // glass butterfly resting & spinning on palm
  TO_POINT: 'toPoint',    // flying toward fingertip
  AT_POINT: 'atPoint',    // resting on fingertip (follows finger)
};

// Base render scales. The glass butterfly is rendered clearly larger (~170%)
// than the normal one so the transformation is obvious.
const NORMAL_SCALE = 0.5;
const GLASS_SCALE  = NORMAL_SCALE * 1.7;
// Morph durations (seconds).
const MORPH_OUT_DUR = 0.28;
const MORPH_IN_DUR  = 0.40;

const motion = {
  state: STATE.WANDER,
  pos: new THREE.Vector3(0, 0, 0),
  target: new THREE.Vector3(0, 0, 0),
  wanderTarget: new THREE.Vector3(0, 0, 0),
  wanderTimer: 0,
  flap: 0,
  spin: 0,
  heading: 0,
  morphT: 0,         // 0..1 progress within a morph phase
  normalScale: 1,    // multiplier applied to NORMAL_SCALE
  glassScale: 0,     // multiplier applied to GLASS_SCALE
  flapIntensity: 1,  // 0 = wings at rest, 1 = full flap
};

function smoothstep(t) {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Particle burst (small "poof" when a butterfly appears / disappears)
// ---------------------------------------------------------------------------
const PARTICLE_COUNT = 80;
let particles;

// Soft round sprite so particles read as glowing dots (and write real alpha,
// which matters when compositing the transparent canvas over the camera feed).
function makeParticleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function initParticles() {
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffe6a8,
    map: makeParticleTexture(),
    size: 0.28,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    depthTest: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.renderOrder = 999;
  points.visible = false;
  points.frustumCulled = false;
  scene.add(points);
  particles = { geo, mat, points, vel: new Float32Array(PARTICLE_COUNT * 3), life: 0, maxLife: 0.7 };
}

function burst(pos, colorHex) {
  const p = particles;
  p.mat.color.setHex(colorHex);
  const arr = p.geo.attributes.position.array;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    arr[i * 3] = pos.x; arr[i * 3 + 1] = pos.y; arr[i * 3 + 2] = pos.z;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const sp = 1.0 + Math.random() * 1.8;
    p.vel[i * 3]     = Math.sin(phi) * Math.cos(theta) * sp;
    p.vel[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * sp;
    p.vel[i * 3 + 2] = Math.cos(phi) * sp;
  }
  p.geo.attributes.position.needsUpdate = true;
  p.life = p.maxLife;
  p.points.visible = true;
}

function updateParticles(dt) {
  const p = particles;
  if (!p || p.life <= 0) return;
  p.life -= dt;
  const arr = p.geo.attributes.position.array;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    arr[i * 3]     += p.vel[i * 3] * dt;
    arr[i * 3 + 1] += p.vel[i * 3 + 1] * dt;
    arr[i * 3 + 2] += p.vel[i * 3 + 2] * dt;
    p.vel[i * 3] *= 0.9; p.vel[i * 3 + 1] *= 0.9; p.vel[i * 3 + 2] *= 0.9;
  }
  p.geo.attributes.position.needsUpdate = true;
  p.mat.opacity = Math.max(0, p.life / p.maxLife);
  if (p.life <= 0) p.points.visible = false;
}

// Convert a screen pixel (x,y) to a world position on the focal plane.
const _ndc = new THREE.Vector3();
const _ray = new THREE.Ray();
function screenToWorld(px, py, out) {
  const ndcX = (px / window.innerWidth) * 2 - 1;
  const ndcY = -(py / window.innerHeight) * 2 + 1;
  _ndc.set(ndcX, ndcY, 0.5).unproject(camera);
  _ray.origin.copy(camera.position);
  _ray.direction.copy(_ndc.sub(camera.position).normalize());
  _ray.intersectPlane(groundPlane, out);
  return out;
}

// Visible world bounds at the focal plane (for wandering).
function visibleBounds() {
  const dist = camera.position.z - FOCAL_DEPTH;
  const h = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const w = h * camera.aspect;
  return { w: w * 0.42, h: h * 0.42 };
}

function pickWanderTarget() {
  const b = visibleBounds();
  motion.wanderTarget.set(
    (Math.random() * 2 - 1) * b.w,
    (Math.random() * 2 - 1) * b.h,
    (Math.random() * 2 - 1) * 0.6
  );
  motion.wanderTimer = 1.5 + Math.random() * 2.0;
}

// ---------------------------------------------------------------------------
// State machine driven by detected gesture
// ---------------------------------------------------------------------------
const PALM_STATES  = [STATE.TO_PALM, STATE.MORPH_OUT, STATE.MORPH_IN, STATE.GLASS];
const POINT_STATES = [STATE.TO_POINT, STATE.AT_POINT];

function updateGestureLogic() {
  const palmActive  = hand.gesture === GESTURE.PALM;
  const pointActive = hand.gesture === GESTURE.POINT;

  iconPalm.classList.toggle('active', palmActive);
  iconPoint.classList.toggle('active', pointActive);

  const inPalm  = PALM_STATES.includes(motion.state);
  const inPoint = POINT_STATES.includes(motion.state);

  // When leaving a palm state where the glass butterfly is visible, poof it and
  // restore the normal butterfly instantly at 100% right where it was.
  const dismissGlass = () => {
    if (motion.state === STATE.MORPH_IN || motion.state === STATE.GLASS) {
      burst(motion.pos, 0xbfe8ff);
    }
    motion.normalScale = 1;
    motion.glassScale = 0;
  };

  if (palmActive) {
    if (motion.state === STATE.WANDER || inPoint) {
      motion.state = STATE.TO_PALM;
      motion.morphT = 0;
    }
  } else if (pointActive) {
    if (inPalm) { dismissGlass(); motion.state = STATE.TO_POINT; }
    else if (motion.state === STATE.WANDER) { motion.state = STATE.TO_POINT; }
  } else {
    // No valid gesture → return to free flight.
    if (inPalm) { dismissGlass(); motion.state = STATE.WANDER; pickWanderTarget(); }
    else if (inPoint) { motion.state = STATE.WANDER; pickWanderTarget(); }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastT = performance.now();
const _palmWorld = new THREE.Vector3();
const _pointWorld = new THREE.Vector3();

function tick() {
  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;

  debounceGesture(dt);
  updateGestureLogic();

  // Live debug feedback so detection state is visible on the device.
  setStatus(`🖐️/👉  mano: ${(performance.now() - hand.lastSeen) < 400 ? 'sí' : 'no'} · gesto: ${hand.gesture} · ${motion.state}`);

  let showGlass = false;
  const ARRIVE = 0.18; // world units considered "arrived"

  switch (motion.state) {
    case STATE.WANDER: {
      motion.wanderTimer -= dt;
      if (motion.wanderTimer <= 0) pickWanderTarget();
      // gentle bobbing on top of the wander target
      motion.target.copy(motion.wanderTarget);
      motion.target.y += Math.sin(now * 0.003) * 0.25;
      motion.target.x += Math.cos(now * 0.0021) * 0.2;
      motion.normalScale = 1;
      motion.glassScale = 0;
      break;
    }
    case STATE.TO_PALM: {
      // Fly to the centre of the palm; once there, begin the morph.
      screenToWorld(hand.palm.x, hand.palm.y, _palmWorld);
      motion.target.copy(_palmWorld);
      motion.normalScale = 1;
      if (motion.pos.distanceTo(motion.target) < ARRIVE) {
        motion.state = STATE.MORPH_OUT;
        motion.morphT = 0;
      }
      break;
    }
    case STATE.MORPH_OUT: {
      // Normal butterfly shrinks 100% -> 0% at the palm centre.
      screenToWorld(hand.palm.x, hand.palm.y, _palmWorld);
      motion.target.copy(_palmWorld);
      motion.morphT += dt / MORPH_OUT_DUR;
      motion.normalScale = 1 - smoothstep(motion.morphT);
      if (motion.morphT >= 1) {
        burst(motion.pos, 0xff8c42); // poof where it vanished
        motion.state = STATE.MORPH_IN;
        motion.morphT = 0;
        motion.normalScale = 0;
        motion.glassScale = 0;
      }
      break;
    }
    case STATE.MORPH_IN: {
      // Glass butterfly grows 0% -> 150% at the palm centre.
      screenToWorld(hand.palm.x, hand.palm.y, _palmWorld);
      motion.target.copy(_palmWorld);
      motion.morphT += dt / MORPH_IN_DUR;
      motion.glassScale = smoothstep(motion.morphT);
      showGlass = true;
      if (motion.morphT >= 1) {
        motion.glassScale = 1;
        motion.state = STATE.GLASS;
      }
      break;
    }
    case STATE.GLASS: {
      screenToWorld(hand.palm.x, hand.palm.y, _palmWorld);
      motion.target.copy(_palmWorld);
      motion.glassScale = 1;
      showGlass = true;
      break;
    }
    case STATE.TO_POINT: {
      screenToWorld(hand.point.x, hand.point.y, _pointWorld);
      motion.target.copy(_pointWorld);
      if (motion.pos.distanceTo(motion.target) < ARRIVE) {
        motion.state = STATE.AT_POINT;
      }
      break;
    }
    case STATE.AT_POINT: {
      screenToWorld(hand.point.x, hand.point.y, _pointWorld);
      motion.target.copy(_pointWorld);
      break;
    }
  }

  // Move toward target. Palm-anchored states track the hand tightly.
  const tight = (motion.state === STATE.GLASS || motion.state === STATE.MORPH_IN || motion.state === STATE.MORPH_OUT);
  if (tight) {
    motion.pos.lerp(motion.target, 1 - Math.pow(0.001, dt));
  } else {
    const speed = (motion.state === STATE.WANDER) ? 2.5 : 5.0;
    motion.pos.lerp(motion.target, 1 - Math.exp(-speed * dt));
  }

  // Orient toward direction of travel.
  const toTarget = _ndc.copy(motion.target).sub(motion.pos);
  if (toTarget.lengthSq() > 1e-4) {
    motion.heading = THREE.MathUtils.lerp(motion.heading, Math.atan2(toTarget.x, -toTarget.y), 0.1);
  }

  // ---- Drive the visible butterfly ----
  const active = showGlass ? glassButterfly : normalButterfly;
  normalButterfly.group.visible = !showGlass && motion.normalScale > 0.001;
  glassButterfly.group.visible  = showGlass && motion.glassScale > 0.001;

  normalButterfly.group.scale.setScalar(NORMAL_SCALE * motion.normalScale);
  glassButterfly.group.scale.setScalar(GLASS_SCALE * motion.glassScale);

  active.group.position.copy(motion.pos);

  if (showGlass) {
    // Static wings, automatic spin on its own vertical axis.
    motion.spin += dt * 1.4;
    active.group.rotation.set(0.12, motion.spin, 0);
    active.rightPivot.rotation.z = 0;
    active.leftPivot.rotation.z  = 0;
  } else {
    const dist = motion.pos.distanceTo(motion.target);

    // While resting on the fingertip, only flap if the finger moves a lot;
    // otherwise the butterfly stays "perched" with wings nearly still.
    let wantFlap = 1;
    if (motion.state === STATE.AT_POINT) {
      wantFlap = dist > 0.22 ? 1 : 0;
    }
    motion.flapIntensity = THREE.MathUtils.lerp(motion.flapIntensity, wantFlap, 0.12);

    const flapSpeed = 12 + Math.min(dist, 3) * 4;
    motion.flap += dt * flapSpeed;
    const REST_POSE = 0.08; // wings slightly open when perched
    const flapping = Math.sin(motion.flap) * 0.6 + 0.15; // radians, fold about body axis
    const flap = flapping * motion.flapIntensity + REST_POSE * (1 - motion.flapIntensity);
    active.leftPivot.rotation.z  =  flap;
    active.rightPivot.rotation.z = -flap;
    // Gentle banking toward travel direction (model already faces the camera).
    active.group.rotation.set(0, 0, motion.heading * 0.3);
  }

  updateParticles(dt);

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// MediaPipe Hands
// ---------------------------------------------------------------------------
let mpHands;
let mpRunning = false;

// Map a normalised MediaPipe landmark to screen pixels, matching the
// CSS `object-fit: cover` applied to the (non-mirrored, rear) <video> element.
function coverMap(nx, ny) {
  const sw = window.innerWidth, sh = window.innerHeight;
  const vw = video.videoWidth || sw, vh = video.videoHeight || sh;
  const scale = Math.max(sw / vw, sh / vh);
  const dispW = vw * scale, dispH = vh * scale;
  const offX = (sw - dispW) / 2, offY = (sh - dispH) / 2;
  const px = offX + nx * dispW;
  const py = offY + ny * dispH;
  return { x: px, y: py };
}

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Decide whether a finger is extended using landmark distances from the wrist.
function fingerExtended(lm, tip, pip) {
  return dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]) * 1.05;
}

function classifyGesture(lm) {
  const index  = fingerExtended(lm, 8, 6);
  const middle = fingerExtended(lm, 12, 10);
  const ring   = fingerExtended(lm, 16, 14);
  const pinky  = fingerExtended(lm, 20, 18);

  const openCount = [index, middle, ring, pinky].filter(Boolean).length;

  if (openCount >= 4) return GESTURE.PALM;
  if (index && !middle && !ring && !pinky) return GESTURE.POINT;
  return GESTURE.NONE;
}

function onHandResults(results) {
  const lms = results.multiHandLandmarks;
  if (!lms || lms.length === 0) {
    hand.raw = GESTURE.NONE; // positions are latched (kept from last frame)
    return;
  }
  const lm = lms[0];
  hand.lastSeen = performance.now();
  hand.raw = classifyGesture(lm);

  // Palm centre = average of wrist + finger MCP joints.
  const palmIds = [0, 5, 9, 13, 17];
  let cx = 0, cy = 0;
  for (const id of palmIds) { cx += lm[id].x; cy += lm[id].y; }
  cx /= palmIds.length; cy /= palmIds.length;
  const palmPx = coverMap(cx, cy);
  hand.palm.x = palmPx.x; hand.palm.y = palmPx.y;

  // Index fingertip.
  const tipPx = coverMap(lm[8].x, lm[8].y);
  hand.point.x = tipPx.x; hand.point.y = tipPx.y;
}

async function initHands() {
  if (typeof Hands === 'undefined') {
    setStatus('No se pudo cargar el detector de manos.');
    return;
  }
  mpHands = new Hands({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${f}`,
  });
  mpHands.setOptions({
    maxNumHands: 1,
    modelComplexity: 0,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
  mpHands.onResults(onHandResults);

  // Feed frames to MediaPipe on its own cadence (decoupled from render loop).
  mpRunning = true;
  const pump = async () => {
    if (!mpRunning) return;
    if (video.readyState >= 2) {
      try { await mpHands.send({ image: video }); } catch (e) { /* ignore frame */ }
    }
    requestAnimationFrame(pump);
  };
  pump();
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
async function startCamera() {
  try {
    setStatus('Solicitando cámara…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    setStatus('Mueve la mano frente a la cámara 🖐️ / 👉');
    return true;
  } catch (err) {
    console.error(err);
    setStatus('No se pudo acceder a la cámara: ' + err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.textContent = 'Cargando…';
  const ok = await startCamera();
  if (!ok) { startBtn.disabled = false; startBtn.textContent = 'Reintentar'; return; }

  startBtn.textContent = 'Cargando modelo…';
  try {
    await loadButterflyAssets();
  } catch (e) {
    console.error(e);
    setStatus('No se pudo cargar el modelo 3D: ' + e.message);
    startBtn.disabled = false; startBtn.textContent = 'Reintentar';
    return;
  }

  overlay.classList.add('hidden');
  initThree();
  pickWanderTarget();
  await initHands();
  requestAnimationFrame(tick);
});
