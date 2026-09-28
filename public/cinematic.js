// JEVBRAIN.WORLD — Cinematic 3D Engine (Three.js WebGL)
import * as THREE from './assets/three.module.js';
import { OrbitControls } from './assets/OrbitControls.js';

// --- Global Configuration ---
const CONFIG = {
  duration: 36.0,
  colors: {
    bg: 0x060608,
    primary: 0xf4f4f5,
    cyan: 0x38bdf8,
    cyanDim: 0x0284c7,
    cyanGlow: 0x06b6d4,
    green: 0x10b981,
    amber: 0xf59e0b,
    dimWire: 0x1e222a
  },
  clusterDefs: [
    { id: 'model', name: 'MODEL (REASONING)', center: [0, 40, -60], count: 420, color: 0x38bdf8 },
    { id: 'memory', name: 'MEMORY (VECTOR)', center: [-120, -10, 20], count: 350, color: 0x0284c7 },
    { id: 'tools', name: 'TOOLS (INTERFACES)', center: [120, -15, 30], count: 300, color: 0x38bdf8 },
    { id: 'agents', name: 'AGENTS (AUTONOMOUS)', center: [-50, 70, 40], count: 260, color: 0x10b981 },
    { id: 'execution', name: 'EXECUTION (RUNTIME)', center: [60, -60, -30], count: 220, color: 0x38bdf8 }
  ]
};

// --- Application State ---
const state = {
  currentTime: 0,
  isPlaying: false,
  isInteractive: false,
  isMuted: true,
  audioCtx: null,
  audioNodes: {}
};

// --- DOM Elements ---
const container = document.getElementById('canvas-container');
const playBtn = document.getElementById('btn-play');
const restartBtn = document.getElementById('btn-restart');
const muteBtn = document.getElementById('btn-mute');
const interactiveBtn = document.getElementById('btn-interactive');
const timeDisplay = document.getElementById('time-display');
const scrubFill = document.getElementById('scrub-fill');
const scrubTrack = document.getElementById('scrub-track');
const startModal = document.getElementById('start-modal');
const interactiveBanner = document.getElementById('interactive-banner');
const inspectorDrawer = document.getElementById('inspector-drawer');
const drawerTag = document.getElementById('drawer-tag');
const drawerTitle = document.getElementById('drawer-title');
const drawerDesc = document.getElementById('drawer-desc');
const drawerSpec1 = document.getElementById('drawer-spec-1');
const drawerSpec2 = document.getElementById('drawer-spec-2');

// --- Three.js Core Components ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.colors.bg);
scene.fog = new THREE.FogExp2(CONFIG.colors.bg, 0.0016);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2500);
camera.position.set(0, 10, 260);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxDistance = 1200;
controls.minDistance = 20;
controls.enabled = false; // Disabled during cinematic choreography

// --- Lighting ---
const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambientLight);

const cyanLight = new THREE.DirectionalLight(CONFIG.colors.cyan, 2.5);
cyanLight.position.set(100, 200, 150);
scene.add(cyanLight);

const blueRim = new THREE.DirectionalLight(CONFIG.colors.cyanDim, 1.8);
blueRim.position.set(-150, -100, -100);
scene.add(blueRim);

// Central Point Light for Seed Node
const coreLight = new THREE.PointLight(CONFIG.colors.cyan, 2, 200);
coreLight.position.set(0, 0, 0);
scene.add(coreLight);

// --- 1. SEED COMPUTATIONAL NODE (Centerpiece for Scene 01) ---
const seedGroup = new THREE.Group();
scene.add(seedGroup);

// Central Octahedral Seed Core
const seedGeo = new THREE.OctahedronGeometry(4.5, 0);
const seedMat = new THREE.MeshStandardMaterial({
  color: CONFIG.colors.primary,
  emissive: CONFIG.colors.cyan,
  emissiveIntensity: 0.6,
  metalness: 0.8,
  roughness: 0.2
});
const seedMesh = new THREE.Mesh(seedGeo, seedMat);
seedGroup.add(seedMesh);

// Inner Wireframe
const seedWireGeo = new THREE.IcosahedronGeometry(6.2, 1);
const seedWireMat = new THREE.MeshBasicMaterial({
  color: CONFIG.colors.cyan,
  wireframe: true,
  transparent: true,
  opacity: 0.4
});
const seedWire = new THREE.Mesh(seedWireGeo, seedWireMat);
seedGroup.add(seedWire);

// Dual Gyroscopic Gimbal Rings
const ringMat = new THREE.MeshBasicMaterial({
  color: CONFIG.colors.cyan,
  wireframe: true,
  transparent: true,
  opacity: 0.5
});
const ring1 = new THREE.Mesh(new THREE.TorusGeometry(8.5, 0.15, 8, 48), ringMat);
const ring2 = new THREE.Mesh(new THREE.TorusGeometry(11.0, 0.15, 8, 48), ringMat);
ring2.rotation.x = Math.PI / 2;
seedGroup.add(ring1);
seedGroup.add(ring2);

// Seed Expansion Pulse Waveform Ring
const pulseRingGeo = new THREE.RingGeometry(1, 1.4, 64);
const pulseRingMat = new THREE.MeshBasicMaterial({
  color: CONFIG.colors.cyan,
  transparent: true,
  opacity: 0,
  side: THREE.DoubleSide
});
const pulseRing = new THREE.Mesh(pulseRingGeo, pulseRingMat);
pulseRing.rotation.x = Math.PI / 2;
scene.add(pulseRing);

// --- 2. MULTI-LAYERED COMPUTATIONAL NODES (InstancedMesh) ---
const totalNodes = CONFIG.clusterDefs.reduce((acc, c) => acc + c.count, 0);
const nodeGeo = new THREE.BoxGeometry(1.6, 1.6, 1.6);
const nodeMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.3,
  metalness: 0.7
});

const nodeInstances = new THREE.InstancedMesh(nodeGeo, nodeMat, totalNodes);
nodeInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(nodeInstances);

// Data structure to hold node coordinates and metadata
const nodeData = [];
const dummy = new THREE.Object3D();
const tempColor = new THREE.Color();

let globalNodeIndex = 0;
CONFIG.clusterDefs.forEach((cluster, cIdx) => {
  const [cx, cy, cz] = cluster.center;

  for (let i = 0; i < cluster.count; i++) {
    let px, py, pz;
    // Architecture-specific cluster topologies
    if (cluster.id === 'model') {
      // 3D Cognitive Lattice (dense volumetric brain matrix)
      const u = (Math.random() - 0.5) * 60;
      const v = (Math.random() - 0.5) * 50;
      const w = (Math.random() - 0.5) * 50;
      px = cx + u; py = cy + v; pz = cz + w;
    } else if (cluster.id === 'memory') {
      // Orthogonal Vector Columns / Memory Bank Slabs
      const col = (i % 7) - 3;
      const row = Math.floor((i / 7) % 7) - 3;
      const stack = Math.floor(i / 49);
      px = cx + col * 10 + (Math.random() - 0.5) * 3;
      py = cy + stack * 9 - 25;
      pz = cz + row * 10 + (Math.random() - 0.5) * 3;
    } else if (cluster.id === 'tools') {
      // Hexagonal Peripheral Docking Ports / Interface Rings
      const angle = (i / cluster.count) * Math.PI * 6;
      const rad = 25 + (i % 5) * 12;
      px = cx + Math.cos(angle) * rad;
      py = cy + ((i % 7) - 3) * 6;
      pz = cz + Math.sin(angle) * rad;
    } else if (cluster.id === 'agents') {
      // 3 Orbital Agent Rings (Agent 01, Agent 02, Warden)
      const ringId = i % 3;
      const subAngle = (i / cluster.count) * Math.PI * 4;
      const subRad = 18 + ringId * 15;
      px = cx + Math.cos(subAngle) * subRad + (ringId - 1) * 20;
      py = cy + Math.sin(subAngle) * subRad;
      pz = cz + ((i % 5) - 2) * 5;
    } else {
      // Execution Linear Pipeline Bus
      const track = (i % 4) - 1.5;
      const progress = (i / cluster.count);
      px = cx + progress * 90 - 45;
      py = cy + track * 8;
      pz = cz + ((i % 6) - 2.5) * 6;
    }

    dummy.position.set(px, py, pz);
    dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    dummy.scale.set(0.001, 0.001, 0.001); // Initial scale 0 (blooms during Scene 02)
    dummy.updateMatrix();

    nodeInstances.setMatrixAt(globalNodeIndex, dummy.matrix);
    tempColor.set(CONFIG.colors.primary);
    nodeInstances.setColorAt(globalNodeIndex, tempColor);

    nodeData.push({
      index: globalNodeIndex,
      clusterId: cluster.id,
      clusterIndex: cIdx,
      basePos: new THREE.Vector3(px, py, pz),
      currentPos: new THREE.Vector3(px, py, pz),
      scale: 0,
      targetScale: 1.0 + Math.random() * 0.5,
      activeIntensity: 0
    });

    globalNodeIndex++;
  }
});
nodeInstances.instanceMatrix.needsUpdate = true;
if (nodeInstances.instanceColor) nodeInstances.instanceColor.needsUpdate = true;

// --- 3. DYNAMIC SYNAPTIC BUS LINES (LineSegments) ---
const connectionPositions = [];
const connectionColors = [];
const activeLines = [];

// Inter-cluster and intra-cluster connections
for (let i = 0; i < nodeData.length; i += 3) {
  const n1 = nodeData[i];
  // Connect to nearby nodes in same cluster
  for (let j = i + 1; j < Math.min(i + 12, nodeData.length); j++) {
    const n2 = nodeData[j];
    if (n1.clusterId === n2.clusterId) {
      const dist = n1.basePos.distanceTo(n2.basePos);
      if (dist < 22) {
        connectionPositions.push(n1.basePos.x, n1.basePos.y, n1.basePos.z);
        connectionPositions.push(n2.basePos.x, n2.basePos.y, n2.basePos.z);
        connectionColors.push(0.12, 0.14, 0.18, 0.12, 0.14, 0.18);
        activeLines.push({ n1, n2, intensity: 0 });
      }
    }
  }
}

// Major Inter-Cluster Data Highways
const highwayCurves = [];
for (let c1 = 0; c1 < CONFIG.clusterDefs.length; c1++) {
  for (let c2 = c1 + 1; c2 < CONFIG.clusterDefs.length; c2++) {
    const p1 = new THREE.Vector3(...CONFIG.clusterDefs[c1].center);
    const p2 = new THREE.Vector3(...CONFIG.clusterDefs[c2].center);
    const mid = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
    mid.y += 25; // Arcing highway spline

    const curve = new THREE.QuadraticBezierCurve3(p1, mid, p2);
    highwayCurves.push(curve);

    const pts = curve.getPoints(24);
    for (let k = 0; k < pts.length - 1; k++) {
      connectionPositions.push(pts[k].x, pts[k].y, pts[k].z);
      connectionPositions.push(pts[k+1].x, pts[k+1].y, pts[k+1].z);
      connectionColors.push(0.08, 0.15, 0.25, 0.08, 0.15, 0.25);
    }
  }
}

const lineGeo = new THREE.BufferGeometry();
lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(connectionPositions, 3));
lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(connectionColors, 3));

const lineMat = new THREE.LineBasicMaterial({
  vertexColors: true,
  transparent: true,
  opacity: 0.35,
  blending: THREE.AdditiveBlending
});
const lineSegments = new THREE.LineSegments(lineGeo, lineMat);
scene.add(lineSegments);

// --- 4. TRAVELING DATA PACKETS (Instanced Points along Splines) ---
const PACKET_COUNT = 320;
const packetGeo = new THREE.BufferGeometry();
const packetPositions = new Float32Array(PACKET_COUNT * 3);
const packetColors = new Float32Array(PACKET_COUNT * 3);
const packetProgress = new Float32Array(PACKET_COUNT);
const packetCurves = [];

for (let i = 0; i < PACKET_COUNT; i++) {
  packetCurves.push(highwayCurves[i % highwayCurves.length]);
  packetProgress[i] = Math.random();
  packetColors[i * 3] = 0.22;
  packetColors[i * 3 + 1] = 0.74;
  packetColors[i * 3 + 2] = 0.97;
}

packetGeo.setAttribute('position', new THREE.BufferAttribute(packetPositions, 3));
packetGeo.setAttribute('color', new THREE.BufferAttribute(packetColors, 3));

const packetMat = new THREE.PointsMaterial({
  size: 3.5,
  vertexColors: true,
  transparent: true,
  opacity: 0.9,
  blending: THREE.AdditiveBlending
});
const packetCloud = new THREE.Points(packetGeo, packetMat);
scene.add(packetCloud);

// --- 5. COHERENT AMBIENT COMPUTATIONAL PARTICLES (Scene 01 onwards) ---
const AMBIENT_COUNT = 450;
const ambGeo = new THREE.BufferGeometry();
const ambPositions = new Float32Array(AMBIENT_COUNT * 3);
const ambSeeds = [];

for (let i = 0; i < AMBIENT_COUNT; i++) {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos((Math.random() * 2) - 1);
  const rad = 20 + Math.random() * 80;
  ambPositions[i * 3] = rad * Math.sin(phi) * Math.cos(theta);
  ambPositions[i * 3 + 1] = rad * Math.sin(phi) * Math.sin(theta);
  ambPositions[i * 3 + 2] = rad * Math.cos(phi);
  ambSeeds.push({ rad, theta, phi, speed: 0.3 + Math.random() * 0.7 });
}
ambGeo.setAttribute('position', new THREE.BufferAttribute(ambPositions, 3));
const ambMat = new THREE.PointsMaterial({
  color: CONFIG.colors.cyan,
  size: 2.2,
  transparent: true,
  opacity: 0.25,
  blending: THREE.AdditiveBlending
});
const ambientCloud = new THREE.Points(ambGeo, ambMat);
scene.add(ambientCloud);

// --- 6. CINEMATIC CAMERA CHOREOGRAPHY SPLINE ---
const cameraKeyframes = [
  // Scene 01: Single Node (0 - 5s)
  { t: 0.0, pos: [0, 8, 240], look: [0, 0, 0] },
  { t: 3.0, pos: [0, 6, 140], look: [0, 0, 0] },
  { t: 5.0, pos: [0, 4, 75], look: [0, 0, 0] },

  // Scene 02: Network Expansion & Fly-through (5 - 12s)
  { t: 6.5, pos: [20, 20, 50], look: [0, 20, -20] },
  { t: 9.0, pos: [70, 35, 10], look: [0, 30, -50] },
  { t: 12.0, pos: [-40, 25, 20], look: [-10, 15, -20] },

  // Scene 03: System Sequential Activation (12 - 18s)
  { t: 13.5, pos: [10, 45, -20], look: [0, 40, -60] },     // MODEL
  { t: 15.0, pos: [-80, 15, 45], look: [-120, -10, 20] },  // MEMORY
  { t: 16.5, pos: [80, 10, 50], look: [120, -15, 30] },    // TOOLS
  { t: 18.0, pos: [-30, 60, 65], look: [-50, 70, 40] },    // AGENTS

  // Scene 04: Autonomous Agent Layer (18 - 25s)
  { t: 20.0, pos: [-55, 75, 55], look: [-50, 70, 40] },
  { t: 22.5, pos: [-70, 65, 30], look: [-40, 60, 25] },
  { t: 25.0, pos: [20, -30, 20], look: [60, -60, -30] },   // EXECUTION BUS

  // Scene 05: Task Flow Pipeline (25 - 30s)
  { t: 27.5, pos: [30, -10, 40], look: [0, 10, -10] },
  { t: 30.0, pos: [0, 30, 60], look: [0, 10, -10] },

  // Scene 06: Final Reveal & Outro Pull-back (30 - 36s)
  { t: 32.0, pos: [0, 70, 180], look: [0, 10, -10] },
  { t: 36.0, pos: [0, 150, 480], look: [0, 10, -10] }
];

function getCameraStateAt(time) {
  const t = Math.max(0, Math.min(CONFIG.duration, time));
  let idx = 0;
  for (let i = 0; i < cameraKeyframes.length - 1; i++) {
    if (t >= cameraKeyframes[i].t && t <= cameraKeyframes[i+1].t) {
      idx = i;
      break;
    }
  }

  const k1 = cameraKeyframes[idx];
  const k2 = cameraKeyframes[idx + 1];
  const segmentRatio = (t - k1.t) / (k2.t - k1.t);
  // Smooth cubic ease
  const ease = segmentRatio < 0.5 ? 4 * segmentRatio * segmentRatio * segmentRatio : 1 - Math.pow(-2 * segmentRatio + 2, 3) / 2;

  const px = k1.pos[0] + (k2.pos[0] - k1.pos[0]) * ease;
  const py = k1.pos[1] + (k2.pos[1] - k1.pos[1]) * ease;
  const pz = k1.pos[2] + (k2.pos[2] - k1.pos[2]) * ease;

  const lx = k1.look[0] + (k2.look[0] - k1.look[0]) * ease;
  const ly = k1.look[1] + (k2.look[1] - k1.look[1]) * ease;
  const lz = k1.look[2] + (k2.look[2] - k1.look[2]) * ease;

  return { pos: new THREE.Vector3(px, py, pz), look: new THREE.Vector3(lx, ly, lz) };
}

// --- 7. WEB AUDIO SYNTHETIC AMBIENT SOUNDSCAPE ---
function initAudio() {
  if (state.audioCtx) return;
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AudioContext();

    // 55 Hz Deep Sub-harmonic drone (Jev Brain Neural resonance)
    const osc = state.audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(55, state.audioCtx.currentTime);

    const filter = state.audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(140, state.audioCtx.currentTime);

    const gain = state.audioCtx.createGain();
    gain.gain.setValueAtTime(0.001, state.audioCtx.currentTime);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(state.audioCtx.destination);
    osc.start();

    state.audioNodes = { osc, filter, gain };
  } catch (e) {
    console.warn('Web Audio not supported or blocked:', e);
  }
}

function updateAudio(time) {
  if (!state.audioCtx || state.isMuted) return;
  const { filter, gain } = state.audioNodes;
  if (!gain) return;

  // Modulate drone frequency and resonance according to scene
  const now = state.audioCtx.currentTime;
  if (time < 5) {
    gain.gain.setTargetAtTime(0.12, now, 0.2);
    filter.frequency.setTargetAtTime(120, now, 0.3);
  } else if (time < 18) {
    gain.gain.setTargetAtTime(0.18, now, 0.2);
    filter.frequency.setTargetAtTime(220 + Math.sin(time * 2) * 60, now, 0.2);
  } else if (time < 30) {
    gain.gain.setTargetAtTime(0.22, now, 0.2);
    filter.frequency.setTargetAtTime(320, now, 0.3);
  } else {
    // Climax pull-out
    gain.gain.setTargetAtTime(0.28, now, 0.2);
    filter.frequency.setTargetAtTime(450, now, 0.3);
  }
}

// --- 8. UI OVERLAY & SCENE TITLES SYNCHRONIZATION ---
const titles = [
  document.getElementById('title-s1'),
  document.getElementById('title-s2'),
  document.getElementById('title-s3'),
  document.getElementById('title-s4'),
  document.getElementById('title-s5'),
  document.getElementById('title-s6')
];

function updateSceneUI(time) {
  if (state.isInteractive) {
    titles.forEach(el => { if (el) el.classList.remove('active'); });
  } else {
    let activeScene = 0;
    if (time < 5.5) activeScene = 0;
    else if (time < 11.5) activeScene = 1;
    else if (time < 17.5) activeScene = 2;
    else if (time < 25.5) activeScene = 3;
    else if (time < 30.5) activeScene = 4;
    else activeScene = 5;

    titles.forEach((el, idx) => {
      if (el) {
        if (idx === activeScene) el.classList.add('active');
        else el.classList.remove('active');
      }
    });
  }

  // Highlight pipeline chips in Scene 03 & 05
  const chips = document.querySelectorAll('.pipe-chip');
  if (time >= 12.0 && time < 18.0) {
    const step = Math.min(4, Math.floor((time - 12.0) / 1.2));
    chips.forEach((c, idx) => {
      if (idx <= step) c.classList.add('active');
      else c.classList.remove('active');
    });
  } else {
    chips.forEach(c => c.classList.remove('active'));
  }

  // Update Scrubber Track
  const pct = (time / CONFIG.duration) * 100;
  if (scrubFill) scrubFill.style.width = `${pct}%`;

  // Format Time Display
  const mins = Math.floor(time / 60).toString().padStart(2, '0');
  const secs = Math.floor(time % 60).toString().padStart(2, '0');
  const ms = Math.floor((time % 1) * 100).toString().padStart(2, '0');
  if (timeDisplay) timeDisplay.textContent = `${mins}:${secs}.${ms}`;
}

// --- 9. DETERMINISTIC ANIMATION EVALUATION ---
export function renderCinematicFrame(time) {
  state.currentTime = time;

  // 1. Camera Motion
  if (!state.isInteractive) {
    const cam = getCameraStateAt(time);
    camera.position.copy(cam.pos);
    camera.lookAt(cam.look);
  } else {
    controls.update();
  }

  // 2. Seed Node Behavior (Scene 01)
  if (time < 6.0) {
    seedGroup.visible = true;
    seedMesh.rotation.y = time * 0.8;
    seedMesh.rotation.x = time * 0.4;
    seedWire.rotation.y = -time * 0.5;
    ring1.rotation.z = time * 1.2;
    ring2.rotation.y = time * 0.9;

    // Pulse Waveform Trigger at t=3.0s
    if (time >= 2.8) {
      const pulseT = (time - 2.8) / 1.8;
      pulseRing.scale.set(pulseT * 28, pulseT * 28, 1);
      pulseRingMat.opacity = Math.max(0, 1 - pulseT) * 0.8;
    } else {
      pulseRingMat.opacity = 0;
    }
  } else {
    seedGroup.visible = false;
    pulseRingMat.opacity = 0;
  }

  // 3. Multi-Layered Nodes Expansion (Scene 02+)
  const expansionProgress = Math.max(0, Math.min(1, (time - 4.8) / 3.0));
  const easeExpansion = expansionProgress * expansionProgress * (3 - 2 * expansionProgress);

  for (let i = 0; i < nodeData.length; i++) {
    const n = nodeData[i];
    let s = n.targetScale * easeExpansion;

    // Sequential Activation Glow in Scene 03
    if (time >= 12.0 && time < 18.0) {
      const clusterActivationTime = 12.0 + n.clusterIndex * 1.2;
      if (time >= clusterActivationTime) {
        const pulseDecay = Math.max(0, 1 - (time - clusterActivationTime) / 1.5);
        s += pulseDecay * 1.2;
      }
    }

    dummy.position.copy(n.basePos);
    // Subtle organic breathing oscillation
    dummy.position.y += Math.sin(time * 2.0 + i) * 0.6;
    dummy.scale.set(s, s, s);
    dummy.rotation.set(time * 0.2 + i, time * 0.3 + i, 0);
    dummy.updateMatrix();

    nodeInstances.setMatrixAt(n.index, dummy.matrix);

    // Active color highlights
    if (time >= 12.0 && time < 18.0 && time >= 12.0 + n.clusterIndex * 1.2) {
      tempColor.set(CONFIG.colors.cyan);
    } else {
      tempColor.set(CONFIG.colors.primary);
    }
    nodeInstances.setColorAt(n.index, tempColor);
  }
  nodeInstances.instanceMatrix.needsUpdate = true;
  if (nodeInstances.instanceColor) nodeInstances.instanceColor.needsUpdate = true;

  // 4. Data Packets Motion
  const pPositions = packetGeo.attributes.position.array;
  for (let i = 0; i < PACKET_COUNT; i++) {
    const curve = packetCurves[i];
    if (!curve) continue;

    // Packets accelerate during activation & execution scenes
    const speed = (time >= 12.0 && time <= 30.0) ? 0.35 : 0.15;
    packetProgress[i] = (packetProgress[i] + speed * 0.016) % 1;

    const pt = curve.getPoint(packetProgress[i]);
    pPositions[i * 3] = pt.x;
    pPositions[i * 3 + 1] = pt.y;
    pPositions[i * 3 + 2] = pt.z;
  }
  packetGeo.attributes.position.needsUpdate = true;

  // 5. Ambient Particles Motion
  const ambPos = ambGeo.attributes.position.array;
  for (let i = 0; i < AMBIENT_COUNT; i++) {
    const seed = ambSeeds[i];
    seed.theta += seed.speed * 0.003;
    ambPos[i * 3] = seed.rad * Math.sin(seed.phi) * Math.cos(seed.theta);
    ambPos[i * 3 + 1] = seed.rad * Math.sin(seed.phi) * Math.sin(seed.theta) + Math.sin(time + i) * 2;
    ambPos[i * 3 + 2] = seed.rad * Math.cos(seed.phi);
  }
  ambGeo.attributes.position.needsUpdate = true;

  // 6. Audio & UI Synchronization
  updateSceneUI(time);
  updateAudio(time);

  // 7. Check Sequence End -> Transition to Interactive Mode
  if (time >= CONFIG.duration && !state.isInteractive) {
    enableInteractiveMode();
  }

  // 8. Render
  renderer.render(scene, camera);
}

// Expose deterministic hook for Playwright frame capture / video export
window.seekCinematicTime = function(t) {
  state.currentTime = Math.max(0, Math.min(CONFIG.duration, t));
  renderCinematicFrame(state.currentTime);
  return true;
};

// --- 10. INTERACTIVE EXPLORATION MODE ---
function enableInteractiveMode() {
  state.isInteractive = true;
  state.isPlaying = false;
  controls.enabled = true;
  controls.target.set(0, 15, -10);

  if (playBtn) playBtn.innerHTML = '▶ <span>REPLAY</span>';
  if (interactiveBanner) interactiveBanner.classList.add('visible');

  // Hide titles so user has unobstructed view of the 3D computational world
  titles.forEach(el => { if (el) el.classList.remove('active'); });

  // Smoothly position camera for orbit exploration
  camera.position.set(0, 160, 480);
  controls.update();
}

function disableInteractiveMode() {
  state.isInteractive = false;
  controls.enabled = false;
  if (interactiveBanner) interactiveBanner.classList.remove('visible');
  if (inspectorDrawer) inspectorDrawer.classList.remove('open');
  updateSceneUI(state.currentTime);
}

// Raycaster for Hover & Selection of Major Systems
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

window.addEventListener('mousemove', (e) => {
  if (!state.isInteractive) return;
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
});

window.addEventListener('click', (e) => {
  if (!state.isInteractive) return;
  // Ignore clicks on controls dock
  if (e.target.closest('.director-dock') || e.target.closest('.system-inspector-drawer')) return;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(nodeInstances);

  if (intersects.length > 0) {
    const instanceId = intersects[0].instanceId;
    const node = nodeData[instanceId];
    if (node) {
      showClusterDrawer(node.clusterId);
    }
  }
});

const CLUSTER_DESCS = {
  model: {
    title: 'Model & Reasoning Core',
    desc: 'Dynamic multi-model router evaluating 510+ frontier and pro models with sub-20ms latency and 95.2% token optimization.',
    spec1: '510+ MODELS',
    spec2: '<1.2ms LATENCY'
  },
  memory: {
    title: 'Associative Vector Memory',
    desc: 'Continuous semantic cache and project embedding index. Persists cross-session instruction graphs and context vectors.',
    spec1: 'SEMANTIC CACHE',
    spec2: '100% PERSISTENT'
  },
  tools: {
    title: 'Sandboxed Tool System',
    desc: 'Secure execution bridges connecting AI agents to bash, file systems, Git repositories, and mobile ADB device runtimes.',
    spec1: 'SAFE SANDBOX',
    spec2: 'REST + CLI'
  },
  agents: {
    title: 'Autonomous Multi-Agent Layer',
    desc: 'Self-directed agent orchestration with Agent Warden pre-flight security firewall preventing destructive commands.',
    spec1: 'WARDEN FIREWALL',
    spec2: 'MULTI-AGENT'
  },
  execution: {
    title: 'Deterministic Execution Bus',
    desc: 'High-throughput runtime managing task queues, Solana Web3 settlements, and cryptographic result verification.',
    spec1: 'SOLANA SETTLED',
    spec2: 'ZERO LOSS'
  }
};

function showClusterDrawer(clusterId) {
  const data = CLUSTER_DESCS[clusterId];
  if (!data || !inspectorDrawer) return;

  drawerTag.textContent = `SYSTEM // ${clusterId.toUpperCase()}`;
  drawerTitle.textContent = data.title;
  drawerDesc.textContent = data.desc;
  drawerSpec1.textContent = data.spec1;
  drawerSpec2.textContent = data.spec2;
  inspectorDrawer.classList.add('open');
}
window.showClusterDrawer = showClusterDrawer;

// --- 11. CONTROLS & EVENT LISTENERS ---
let lastTimestamp = performance.now();
function animate(now) {
  const dt = (now - lastTimestamp) / 1000;
  lastTimestamp = now;

  if (state.isPlaying && !state.isInteractive) {
    state.currentTime += dt;
    if (state.currentTime > CONFIG.duration) {
      state.currentTime = CONFIG.duration;
    }
  }

  renderCinematicFrame(state.currentTime);
  requestAnimationFrame(animate);
}

// Play / Pause Toggle
if (playBtn) {
  playBtn.addEventListener('click', () => {
    initAudio();
    if (state.isInteractive) {
      // Replay cinematic
      disableInteractiveMode();
      state.currentTime = 0;
      state.isPlaying = true;
      playBtn.innerHTML = '❚❚ <span>PAUSE</span>';
    } else {
      state.isPlaying = !state.isPlaying;
      playBtn.innerHTML = state.isPlaying ? '❚❚ <span>PAUSE</span>' : '▶ <span>PLAY</span>';
    }
  });
}

// Restart
if (restartBtn) {
  restartBtn.addEventListener('click', () => {
    initAudio();
    disableInteractiveMode();
    state.currentTime = 0;
    state.isPlaying = true;
    if (playBtn) playBtn.innerHTML = '❚❚ <span>PAUSE</span>';
  });
}

// Mute / Unmute
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    initAudio();
    state.isMuted = !state.isMuted;
    muteBtn.innerHTML = state.isMuted ? '🔇 <span>UNMUTE</span>' : '🔊 <span>SOUND ON</span>';
    if (!state.isMuted && state.audioCtx && state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }
  });
}

// Manual Interactive Mode Toggle
if (interactiveBtn) {
  interactiveBtn.addEventListener('click', () => {
    initAudio();
    if (state.isInteractive) {
      disableInteractiveMode();
      state.isPlaying = true;
      if (playBtn) playBtn.innerHTML = '❚❚ <span>PAUSE</span>';
    } else {
      enableInteractiveMode();
    }
  });
}

// Scrubbing on Timeline
if (scrubTrack) {
  scrubTrack.addEventListener('click', (e) => {
    const rect = scrubTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    state.currentTime = ratio * CONFIG.duration;
    disableInteractiveMode();
    renderCinematicFrame(state.currentTime);
  });
}

// Start Modal (handles browser user-gesture autoplay requirements)
if (startModal) {
  startModal.addEventListener('click', () => {
    initAudio();
    state.isMuted = false;
    if (muteBtn) muteBtn.innerHTML = '🔊 <span>SOUND ON</span>';
    startModal.classList.add('hidden');
    state.isPlaying = true;
    if (playBtn) playBtn.innerHTML = '❚❚ <span>PAUSE</span>';
  });
}

// Auto-start if ?autoplay=true is in URL
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('recording') === 'true' || urlParams.get('clean') === 'true') {
  document.body.classList.add('recording-mode');
}
if (urlParams.get('autoplay') === 'true') {
  if (startModal) startModal.classList.add('hidden');
  state.isPlaying = true;
  if (playBtn) playBtn.innerHTML = '❚❚ <span>PAUSE</span>';
}

// Handle Window Resizing
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Start Animation Loop
requestAnimationFrame(animate);
