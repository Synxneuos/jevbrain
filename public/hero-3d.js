// JEVBRAIN.WORLD — Lightweight Hero 3D Computational Background
import * as THREE from './assets/three.module.js';

(function initHero3D() {
  const container = document.getElementById('hero-3d-bg');
  if (!container) return;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x09090b, 0.003);

  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(0, 5, 90);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  container.appendChild(renderer.domElement);

  // Subtle Cyan and White Lights
  const ambLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambLight);

  const dirLight = new THREE.DirectionalLight(0x38bdf8, 1.8);
  dirLight.position.set(40, 60, 40);
  scene.add(dirLight);

  // Seed Computational Core
  const coreGroup = new THREE.Group();
  scene.add(coreGroup);

  const coreGeo = new THREE.OctahedronGeometry(5, 0);
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0xf4f4f5,
    emissive: 0x38bdf8,
    emissiveIntensity: 0.5,
    metalness: 0.8,
    roughness: 0.2
  });
  const coreMesh = new THREE.Mesh(coreGeo, coreMat);
  coreGroup.add(coreMesh);

  const ringGeo = new THREE.TorusGeometry(8.5, 0.1, 8, 48);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, wireframe: true, transparent: true, opacity: 0.4 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  coreGroup.add(ring);

  // 120 Floating Network Nodes
  const nodeCount = 120;
  const nodeGeo = new THREE.BoxGeometry(1.2, 1.2, 1.2);
  const nodeMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.3 });
  const nodes = new THREE.InstancedMesh(nodeGeo, nodeMat, nodeCount);
  const dummy = new THREE.Object3D();

  const nodePositions = [];
  for (let i = 0; i < nodeCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const rad = 20 + Math.random() * 65;
    const y = (Math.random() - 0.5) * 45;
    const x = Math.cos(angle) * rad;
    const z = Math.sin(angle) * rad;

    dummy.position.set(x, y, z);
    dummy.scale.setScalar(0.7 + Math.random() * 0.6);
    dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    dummy.updateMatrix();
    nodes.setMatrixAt(i, dummy.matrix);
    nodePositions.push({ x, y, z, origY: y, speed: 0.4 + Math.random() * 0.6 });
  }
  nodes.instanceMatrix.needsUpdate = true;
  scene.add(nodes);

  // Connecting Lines
  const linePositions = [];
  for (let i = 0; i < nodeCount; i += 2) {
    const p1 = nodePositions[i];
    for (let j = i + 1; j < Math.min(i + 5, nodeCount); j++) {
      const p2 = nodePositions[j];
      const dx = p1.x - p2.x, dy = p1.y - p2.y, dz = p1.z - p2.z;
      if (Math.sqrt(dx*dx + dy*dy + dz*dz) < 28) {
        linePositions.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
      }
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
  const lineMat = new THREE.LineBasicMaterial({ color: 0x0284c7, transparent: true, opacity: 0.25 });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  scene.add(lines);

  // Scroll Responsive Camera Dolly
  let scrollProgress = 0;
  const scrollPane = document.getElementById('claude-center');
  if (scrollPane) {
    scrollPane.addEventListener('scroll', () => {
      const maxScroll = scrollPane.scrollHeight - scrollPane.clientHeight || 1;
      scrollProgress = Math.min(1, Math.max(0, scrollPane.scrollTop / (maxScroll * 0.5)));
    });
  }

  // Animation Loop
  let clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const time = clock.getElapsedTime();

    coreMesh.rotation.y = time * 0.4;
    coreMesh.rotation.x = time * 0.2;
    ring.rotation.z = time * 0.6;
    ring.rotation.y = time * 0.3;

    // Smooth scroll camera dolly into the computational world
    const targetZ = 90 - scrollProgress * 55;
    const targetY = 5 - scrollProgress * 15;
    camera.position.z += (targetZ - camera.position.z) * 0.05;
    camera.position.y += (targetY - camera.position.y) * 0.05;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', () => {
    if (!container) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });
})();
