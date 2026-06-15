import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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
  gesture: GESTURE.NONE,
  // Latest screen-pixel positions for palm centre and index fingertip.
  palm:  { x: 0, y: 0, visible: false },
  point: { x: 0, y: 0, visible: false },
  lastSeen: 0,
};

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

  normalButterfly = createButterfly(false);
  glassButterfly  = createButterfly(true);
  glassButterfly.group.visible = false;
  scene.add(normalButterfly.group);
  scene.add(glassButterfly.group);

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
// Butterfly geometry (procedural)
// ---------------------------------------------------------------------------
function wingShape() {
  // A single butterfly wing made of an upper + lower lobe.
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(0.2, 0.9, 1.0, 1.1, 1.15, 0.35);
  s.bezierCurveTo(1.25, -0.05, 0.95, -0.15, 0.75, -0.1);
  s.bezierCurveTo(1.05, -0.35, 0.95, -0.95, 0.55, -1.0);
  s.bezierCurveTo(0.25, -1.0, 0.05, -0.55, 0, 0);
  return s;
}

function createButterfly(isGlass) {
  const group = new THREE.Group();

  const geom = new THREE.ShapeGeometry(wingShape(), 24);

  let wingMat;
  if (isGlass) {
    wingMat = new THREE.MeshPhysicalMaterial({
      color: 0xbfe8ff,
      metalness: 0,
      roughness: 0.02,
      transmission: 1.0,
      thickness: 0.6,
      ior: 1.5,
      transparent: true,
      side: THREE.DoubleSide,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.4,
    });
  } else {
    wingMat = new THREE.MeshStandardMaterial({
      color: 0xff8c42,
      emissive: 0x551100,
      emissiveIntensity: 0.25,
      roughness: 0.55,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
  }

  // Left & right wing pivots so they can flap around the body axis (Y).
  const rightPivot = new THREE.Group();
  const leftPivot  = new THREE.Group();

  const rightWing = new THREE.Mesh(geom, wingMat);
  const leftWing  = new THREE.Mesh(geom, wingMat);
  leftWing.scale.x = -1; // mirror

  rightPivot.add(rightWing);
  leftPivot.add(leftWing);

  // Body.
  const bodyMat = isGlass
    ? wingMat
    : new THREE.MeshStandardMaterial({ color: 0x2a1a0a, roughness: 0.6 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.9, 6, 12), bodyMat);
  body.rotation.x = Math.PI / 2; // lie along Z so wings spread sideways
  group.add(body);

  group.add(rightPivot);
  group.add(leftPivot);

  const scale = 0.5;
  group.scale.setScalar(scale);

  return { group, rightPivot, leftPivot, isGlass };
}

// ---------------------------------------------------------------------------
// Behaviour / motion
// ---------------------------------------------------------------------------
const STATE = {
  WANDER: 'wander',     // normal butterfly flying randomly
  TO_PALM: 'toPalm',    // flying toward palm centre
  GLASS: 'glass',       // glass butterfly resting & spinning on palm
  TO_POINT: 'toPoint',  // flying toward fingertip
  AT_POINT: 'atPoint',  // resting on fingertip (follows finger)
};

const motion = {
  state: STATE.WANDER,
  pos: new THREE.Vector3(0, 0, 0),
  target: new THREE.Vector3(0, 0, 0),
  wanderTarget: new THREE.Vector3(0, 0, 0),
  wanderTimer: 0,
  flap: 0,
  spin: 0,
  heading: 0,
};

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
function updateGestureLogic() {
  const g = hand.gesture;
  iconPalm.classList.toggle('active', g === GESTURE.PALM);
  iconPoint.classList.toggle('active', g === GESTURE.POINT);

  const handFresh = (performance.now() - hand.lastSeen) < 700;

  if (g === GESTURE.PALM && handFresh && hand.palm.visible) {
    if (motion.state === STATE.WANDER || motion.state === STATE.TO_POINT || motion.state === STATE.AT_POINT) {
      motion.state = STATE.TO_PALM;
    }
  } else if (g === GESTURE.POINT && handFresh && hand.point.visible) {
    if (motion.state === STATE.WANDER || motion.state === STATE.TO_PALM || motion.state === STATE.GLASS) {
      motion.state = STATE.TO_POINT;
    }
  } else {
    // No (valid) gesture → return to free flight.
    if (motion.state !== STATE.WANDER) {
      motion.state = STATE.WANDER;
      pickWanderTarget();
    }
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

  updateGestureLogic();

  let showGlass = false;
  let arrived = false;
  const ARRIVE = 0.18; // world units considered "arrived"

  switch (motion.state) {
    case STATE.WANDER: {
      motion.wanderTimer -= dt;
      if (motion.wanderTimer <= 0) pickWanderTarget();
      // gentle bobbing on top of the wander target
      motion.target.copy(motion.wanderTarget);
      motion.target.y += Math.sin(now * 0.003) * 0.25;
      motion.target.x += Math.cos(now * 0.0021) * 0.2;
      break;
    }
    case STATE.TO_PALM: {
      screenToWorld(hand.palm.x, hand.palm.y, _palmWorld);
      motion.target.copy(_palmWorld);
      if (motion.pos.distanceTo(motion.target) < ARRIVE) {
        motion.state = STATE.GLASS;
      }
      break;
    }
    case STATE.GLASS: {
      screenToWorld(hand.palm.x, hand.palm.y, _palmWorld);
      motion.target.copy(_palmWorld);
      motion.pos.lerp(motion.target, 1 - Math.pow(0.001, dt)); // tight follow
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

  // Move toward target (glass already lerped above).
  if (motion.state !== STATE.GLASS) {
    const speed = (motion.state === STATE.WANDER) ? 2.5 : 5.0;
    const ease = 1 - Math.exp(-speed * dt);
    motion.pos.lerp(motion.target, ease);
  }

  // Orient toward direction of travel.
  const toTarget = _ndc.copy(motion.target).sub(motion.pos);
  if (toTarget.lengthSq() > 1e-4) {
    motion.heading = THREE.MathUtils.lerp(motion.heading, Math.atan2(toTarget.x, -toTarget.y), 0.1);
  }

  // ---- Drive the visible butterfly ----
  const active = showGlass ? glassButterfly : normalButterfly;
  normalButterfly.group.visible = !showGlass;
  glassButterfly.group.visible  = showGlass;

  active.group.position.copy(motion.pos);

  if (showGlass) {
    // Static wings, automatic spin on its own vertical axis.
    motion.spin += dt * 1.4;
    active.group.rotation.set(0.2, motion.spin, 0);
    active.rightPivot.rotation.y = -0.35;
    active.leftPivot.rotation.y  =  0.35;
  } else {
    // Flapping. Faster when travelling.
    const dist = motion.pos.distanceTo(motion.target);
    const flapSpeed = 12 + Math.min(dist, 3) * 4;
    motion.flap += dt * flapSpeed;
    const flap = Math.sin(motion.flap) * 0.9 + 0.2;
    active.rightPivot.rotation.y = -flap;
    active.leftPivot.rotation.y  =  flap;
    // Banking / facing.
    active.group.rotation.set(-0.35, 0, motion.heading);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// MediaPipe Hands
// ---------------------------------------------------------------------------
let mpHands;
let mpRunning = false;

// Map a normalised MediaPipe landmark to mirrored screen pixels, matching the
// CSS `object-fit: cover` + `scaleX(-1)` applied to the <video> element.
function coverMap(nx, ny) {
  const sw = window.innerWidth, sh = window.innerHeight;
  const vw = video.videoWidth || sw, vh = video.videoHeight || sh;
  const scale = Math.max(sw / vw, sh / vh);
  const dispW = vw * scale, dispH = vh * scale;
  const offX = (sw - dispW) / 2, offY = (sh - dispH) / 2;
  let px = offX + nx * dispW;
  const py = offY + ny * dispH;
  px = sw - px; // mirror (video is scaleX(-1))
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
    hand.gesture = GESTURE.NONE;
    hand.palm.visible = false;
    hand.point.visible = false;
    return;
  }
  const lm = lms[0];
  hand.lastSeen = performance.now();
  hand.gesture = classifyGesture(lm);

  // Palm centre = average of wrist + finger MCP joints.
  const palmIds = [0, 5, 9, 13, 17];
  let cx = 0, cy = 0;
  for (const id of palmIds) { cx += lm[id].x; cy += lm[id].y; }
  cx /= palmIds.length; cy /= palmIds.length;
  const palmPx = coverMap(cx, cy);
  hand.palm.x = palmPx.x; hand.palm.y = palmPx.y; hand.palm.visible = true;

  // Index fingertip.
  const tipPx = coverMap(lm[8].x, lm[8].y);
  hand.point.x = tipPx.x; hand.point.y = tipPx.y; hand.point.visible = true;
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

  overlay.classList.add('hidden');
  initThree();
  pickWanderTarget();
  await initHands();
  requestAnimationFrame(tick);
});
