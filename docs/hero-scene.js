import * as THREE from "three";

const canvas = document.getElementById("bus-canvas");
if (!canvas) {
  // Static fallback — page still works without WebGL
} else {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const AGENTS = [
    { name: "Claude", color: 0x22c55e, angle: 0 },
    { name: "Codex", color: 0x38bdf8, angle: Math.PI * 0.33 },
    { name: "Gemini", color: 0xfbbf24, angle: Math.PI * 0.66 },
    { name: "Grok", color: 0xf87171, angle: Math.PI },
    { name: "Cursor", color: 0xa78bfa, angle: Math.PI * 1.33 },
    { name: "Antigravity", color: 0xfb923c, angle: Math.PI * 1.66 },
  ];

  const ORBIT_RADIUS = 2.4;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0.6, 6.2);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Hub — wireframe icosahedron
  const hubGeo = new THREE.IcosahedronGeometry(0.55, 1);
  const hubMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    emissive: 0x22c55e,
    emissiveIntensity: 0.35,
    metalness: 0.6,
    roughness: 0.35,
    wireframe: true,
  });
  const hub = new THREE.Mesh(hubGeo, hubMat);
  scene.add(hub);

  const hubCore = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 16, 16),
    new THREE.MeshStandardMaterial({
      color: 0x22c55e,
      emissive: 0x22c55e,
      emissiveIntensity: 0.8,
      metalness: 0.2,
      roughness: 0.4,
    })
  );
  scene.add(hubCore);

  // Ring
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.85, 0.012, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.35 })
  );
  ring.rotation.x = Math.PI / 2;
  scene.add(ring);

  // Agent nodes
  const nodes = [];
  const lineGroup = new THREE.Group();
  scene.add(lineGroup);

  for (const agent of AGENTS) {
    const x = Math.cos(agent.angle) * ORBIT_RADIUS;
    const z = Math.sin(agent.angle) * ORBIT_RADIUS;

    const node = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 20, 20),
      new THREE.MeshStandardMaterial({
        color: agent.color,
        emissive: agent.color,
        emissiveIntensity: 0.45,
        metalness: 0.3,
        roughness: 0.5,
      })
    );
    node.position.set(x, 0, z);
    node.userData = { baseAngle: agent.angle, color: agent.color };
    scene.add(node);
    nodes.push(node);

    const points = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(x, 0, z)];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({
      color: agent.color,
      transparent: true,
      opacity: 0.22,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    lineGroup.add(line);
  }

  // Flow particles along lines
  const particleCount = reducedMotion ? 60 : 180;
  const particleGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(particleCount * 3);
  const colors = new Float32Array(particleCount * 3);
  const speeds = new Float32Array(particleCount);
  const lineIndices = new Uint8Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    const t = Math.random();
    const lineIdx = i % AGENTS.length;
    const agent = AGENTS[lineIdx];
    const x = Math.cos(agent.angle) * ORBIT_RADIUS * t;
    const z = Math.sin(agent.angle) * ORBIT_RADIUS * t;
    positions[i * 3] = x;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 0.08;
    positions[i * 3 + 2] = z;

    const c = new THREE.Color(agent.color);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;

    speeds[i] = 0.15 + Math.random() * 0.35;
    lineIndices[i] = lineIdx;
  }

  particleGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  particleGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const particleMat = new THREE.PointsMaterial({
    size: 0.06,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const particles = new THREE.Points(particleGeo, particleMat);
  scene.add(particles);

  // Ambient field particles
  const fieldCount = reducedMotion ? 40 : 120;
  const fieldGeo = new THREE.BufferGeometry();
  const fieldPos = new Float32Array(fieldCount * 3);
  for (let i = 0; i < fieldCount; i++) {
    fieldPos[i * 3] = (Math.random() - 0.5) * 8;
    fieldPos[i * 3 + 1] = (Math.random() - 0.5) * 4;
    fieldPos[i * 3 + 2] = (Math.random() - 0.5) * 8;
  }
  fieldGeo.setAttribute("position", new THREE.BufferAttribute(fieldPos, 3));
  const field = new THREE.Points(
    fieldGeo,
    new THREE.PointsMaterial({
      color: 0x64748b,
      size: 0.025,
      transparent: true,
      opacity: 0.4,
    })
  );
  scene.add(field);

  // Lights
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(4, 6, 5);
  scene.add(key);
  const rim = new THREE.PointLight(0x22c55e, 1.2, 12);
  rim.position.set(-3, 2, -2);
  scene.add(rim);

  // Mouse parallax
  const pointer = { x: 0, y: 0 };
  const frame = canvas.closest(".visual-frame");

  frame?.addEventListener("pointermove", (event) => {
    const rect = frame.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    pointer.y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
  });

  frame?.addEventListener("pointerleave", () => {
    pointer.x = 0;
    pointer.y = 0;
  });

  function resize() {
    const rect = frame?.getBoundingClientRect() ?? canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  resize();
  window.addEventListener("resize", resize);

  const clock = new THREE.Clock();
  let rafId = 0;

  function animate() {
    rafId = requestAnimationFrame(animate);
    const elapsed = clock.getElapsedTime();
    const delta = clock.getDelta();

    if (!reducedMotion) {
      hub.rotation.y += delta * 0.35;
      hub.rotation.x = Math.sin(elapsed * 0.4) * 0.12;
      hubCore.rotation.y -= delta * 0.5;
      ring.rotation.z += delta * 0.2;

      for (const node of nodes) {
        const wobble = Math.sin(elapsed * 1.5 + node.userData.baseAngle) * 0.06;
        const angle = node.userData.baseAngle + elapsed * 0.08;
        node.position.x = Math.cos(angle) * (ORBIT_RADIUS + wobble);
        node.position.z = Math.sin(angle) * (ORBIT_RADIUS + wobble);
        node.position.y = Math.sin(elapsed * 2 + node.userData.baseAngle) * 0.08;
      }

      // Update line endpoints
      let lineIdx = 0;
      for (const child of lineGroup.children) {
        const node = nodes[lineIdx];
        const pos = child.geometry.attributes.position;
        pos.setXYZ(1, node.position.x, node.position.y, node.position.z);
        pos.needsUpdate = true;
        lineIdx++;
      }

      // Animate flow particles
      const posAttr = particleGeo.attributes.position;
      for (let i = 0; i < particleCount; i++) {
        const agent = AGENTS[lineIndices[i]];
        let t = (elapsed * speeds[i] + i * 0.07) % 1;
        const x = Math.cos(agent.angle) * ORBIT_RADIUS * t;
        const z = Math.sin(agent.angle) * ORBIT_RADIUS * t;
        posAttr.setXYZ(i, x, posAttr.getY(i), z);
      }
      posAttr.needsUpdate = true;

      field.rotation.y += delta * 0.03;
    }

    camera.position.x += (pointer.x * 0.35 - camera.position.x) * 0.04;
    camera.position.y += (0.6 - pointer.y * 0.25 - camera.position.y) * 0.04;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }

  // Pause when off-screen
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) {
        if (!rafId) animate();
      } else {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    },
    { threshold: 0.1 }
  );
  observer.observe(canvas);

  animate();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    } else if (!rafId) {
      animate();
    }
  });
}
