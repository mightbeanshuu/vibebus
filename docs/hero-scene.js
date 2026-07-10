import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

const canvas = document.getElementById("bus-canvas");
if (!canvas) {
  // Static fallback — page still works without WebGL
} else {
  (async () => {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isMobile = window.matchMedia("(max-width: 640px)").matches;

  // Brand palette from topology.svg + logo.svg
  const AGENTS = [
    { name: "Claude", color: 0x83f7c6, pos: [-2.65, 1.05, 0.15], logo: "assets/logos/claude.svg" },
    { name: "Codex", color: 0x62d6ff, pos: [-2.65, 0, 0], logo: "assets/logos/codex.svg" },
    { name: "Gemini", color: 0xffd166, pos: [-2.65, -1.05, -0.1], logo: "assets/logos/gemini.svg" },
    { name: "Grok", color: 0xff6b6b, pos: [2.65, 1.05, 0.1], logo: "assets/logos/grok.svg" },
    { name: "Cursor", color: 0xc084fc, pos: [2.65, 0, 0], logo: "assets/logos/cursor.svg" },
    { name: "Antigravity", color: 0x94a3b8, pos: [2.65, -1.05, -0.15], logo: "assets/logos/antigravity.png" },
  ];

  function loadLogoTexture(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => {
        const texture = new THREE.Texture(image);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        resolve(texture);
      };
      image.onerror = reject;
      image.src = url;
    });
  }

  function createGlowTexture() {
    const size = 128;
    const el = document.createElement("canvas");
    el.width = el.height = size;
    const ctx = el.getContext("2d");
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.15, "rgba(255,255,255,0.85)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.25)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(el);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  function makeCurve(from, to) {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const mid = start.clone().lerp(end, 0.5);
    mid.y += start.x < 0 ? 0.35 : -0.35;
    mid.z += 0.25;
    return new THREE.QuadraticBezierCurve3(start, mid, end);
  }

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x060a12, 0.055);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(0, 0.15, 7.4);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !isMobile,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const glowTexture = createGlowTexture();
  const busGroup = new THREE.Group();
  scene.add(busGroup);

  // Central hub — layered geometry
  const hubShell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.62, 1),
    new THREE.MeshStandardMaterial({
      color: 0x0a1018,
      emissive: 0x22c55e,
      emissiveIntensity: 0.55,
      metalness: 0.85,
      roughness: 0.2,
      wireframe: true,
    })
  );
  busGroup.add(hubShell);

  const hubInner = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.34, 0),
    new THREE.MeshStandardMaterial({
      color: 0x83f7c6,
      emissive: 0x22c55e,
      emissiveIntensity: 1.2,
      metalness: 0.4,
      roughness: 0.15,
      transparent: true,
      opacity: 0.92,
    })
  );
  busGroup.add(hubInner);

  const hubCore = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 24, 24),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x83f7c6,
      emissiveIntensity: 2.2,
      metalness: 0.1,
      roughness: 0.1,
    })
  );
  busGroup.add(hubCore);

  const rings = [];
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.78 + i * 0.22, 0.008 + i * 0.004, 8, 96),
      new THREE.MeshBasicMaterial({
        color: [0x83f7c6, 0x62d6ff, 0xffd166][i],
        transparent: true,
        opacity: 0.35 - i * 0.08,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    ring.rotation.x = Math.PI / 2 + i * 0.18;
    ring.rotation.y = i * 0.4;
    busGroup.add(ring);
    rings.push(ring);
  }

  // Agent nodes + curved wire tubes
  const nodes = [];
  const curves = [];
  const packets = [];
  const logoTextures = await Promise.all(AGENTS.map((agent) => loadLogoTexture(agent.logo)));

  for (let i = 0; i < AGENTS.length; i++) {
    const agent = AGENTS[i];
    const nodeGroup = new THREE.Group();

    const plate = new THREE.Mesh(
      new THREE.CircleGeometry(0.3, 32),
      new THREE.MeshBasicMaterial({
        color: 0x0b1220,
        transparent: true,
        opacity: 0.92,
      })
    );
    nodeGroup.add(plate);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.27, 0.32, 32),
      new THREE.MeshBasicMaterial({
        color: agent.color,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    nodeGroup.add(ring);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 16, 16),
      new THREE.MeshBasicMaterial({
        color: agent.color,
        transparent: true,
        opacity: 0.1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    nodeGroup.add(halo);

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: logoTextures[i],
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      })
    );
    sprite.scale.set(0.52, 0.52, 1);
    sprite.position.z = 0.08;
    sprite.renderOrder = 5;
    nodeGroup.add(sprite);

    nodeGroup.position.set(...agent.pos);
    nodeGroup.userData = {
      base: agent.pos.slice(),
      color: agent.color,
      name: agent.name,
      sprite,
      baseScale: 0.52,
    };
    busGroup.add(nodeGroup);
    nodes.push(nodeGroup);

    const curve = makeCurve(agent.pos, [0, 0, 0]);
    curves.push(curve);

    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 48, 0.012, 8, false),
      new THREE.MeshBasicMaterial({
        color: agent.color,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    busGroup.add(tube);

    const packetCount = reducedMotion ? 1 : 2;
    for (let p = 0; p < packetCount; p++) {
      const packet = new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 12, 12),
        new THREE.MeshBasicMaterial({
          color: agent.color,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      packet.userData = {
        curve,
        speed: 0.22 + p * 0.12 + Math.random() * 0.08,
        offset: p / packetCount + Math.random() * 0.2,
        dir: agent.pos[0] < 0 ? 1 : -1,
      };
      busGroup.add(packet);
      packets.push(packet);
    }
  }

  // Ambient star field
  const starCount = reducedMotion ? 80 : 220;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    starPos[i * 3] = (Math.random() - 0.5) * 14;
    starPos[i * 3 + 1] = (Math.random() - 0.5) * 8;
    starPos[i * 3 + 2] = (Math.random() - 0.5) * 10 - 2;
  }
  const stars = new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(starPos, 3)),
    new THREE.PointsMaterial({
      map: glowTexture,
      size: 0.05,
      transparent: true,
      opacity: 0.55,
      color: 0x94a3b8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
  );
  scene.add(stars);

  // Floating bus particles
  const dustCount = reducedMotion ? 50 : 140;
  const dustPos = new Float32Array(dustCount * 3);
  const dustColors = new Float32Array(dustCount * 3);
  const dustSpeeds = new Float32Array(dustCount);
  const palette = [0x83f7c6, 0x62d6ff, 0xffd166, 0x22c55e];

  for (let i = 0; i < dustCount; i++) {
    const curve = curves[i % curves.length];
    const t = Math.random();
    const pt = curve.getPoint(t);
    dustPos[i * 3] = pt.x + (Math.random() - 0.5) * 0.15;
    dustPos[i * 3 + 1] = pt.y + (Math.random() - 0.5) * 0.15;
    dustPos[i * 3 + 2] = pt.z + (Math.random() - 0.5) * 0.15;
    const c = new THREE.Color(palette[i % palette.length]);
    dustColors[i * 3] = c.r;
    dustColors[i * 3 + 1] = c.g;
    dustColors[i * 3 + 2] = c.b;
    dustSpeeds[i] = 0.08 + Math.random() * 0.2;
  }

  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute("color", new THREE.BufferAttribute(dustColors, 3));
  const dust = new THREE.Points(
    dustGeo,
    new THREE.PointsMaterial({
      map: glowTexture,
      size: 0.07,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
  );
  busGroup.add(dust);

  // Lights
  scene.add(new THREE.AmbientLight(0x404860, 0.45));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(3, 5, 6);
  scene.add(key);
  const fill = new THREE.PointLight(0x62d6ff, 1.4, 14);
  fill.position.set(-4, -1, 3);
  scene.add(fill);
  const rim = new THREE.PointLight(0x83f7c6, 1.6, 12);
  rim.position.set(2, 2, -3);
  scene.add(rim);

  // Post-processing bloom
  let composer = null;
  if (!isMobile) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.45, 0.18);
    composer.addPass(bloom);
  }

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
    composer?.setSize(w, h);
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
      hubShell.rotation.y += delta * 0.45;
      hubShell.rotation.x = Math.sin(elapsed * 0.5) * 0.15;
      hubInner.rotation.y -= delta * 0.7;
      hubInner.rotation.z = Math.sin(elapsed * 0.8) * 0.2;
      hubCore.scale.setScalar(1 + Math.sin(elapsed * 2.2) * 0.08);

      for (let i = 0; i < rings.length; i++) {
        rings[i].rotation.z += delta * (0.15 + i * 0.08);
        rings[i].rotation.x = Math.PI / 2 + i * 0.18 + Math.sin(elapsed * 0.6 + i) * 0.06;
      }

      for (const nodeGroup of nodes) {
        const [bx, by, bz] = nodeGroup.userData.base;
        const phase = elapsed * 1.6 + bx;
        nodeGroup.position.x = bx + Math.sin(phase) * 0.04;
        nodeGroup.position.y = by + Math.cos(phase * 1.2) * 0.06;
        nodeGroup.position.z = bz + Math.sin(phase * 0.8) * 0.03;
        const pulse = 1 + Math.sin(elapsed * 2 + bx) * 0.06;
        const scale = nodeGroup.userData.baseScale * pulse;
        nodeGroup.userData.sprite.scale.set(scale, scale, 1);
      }

      for (const packet of packets) {
        const { curve, speed, offset, dir } = packet.userData;
        let t = (elapsed * speed + offset) % 1;
        if (dir < 0) t = 1 - t;
        const pt = curve.getPoint(t);
        packet.position.copy(pt);
        const scale = 0.8 + Math.sin(elapsed * 8 + offset * 10) * 0.2;
        packet.scale.setScalar(scale);
      }

      const dustAttr = dustGeo.attributes.position;
      for (let i = 0; i < dustCount; i++) {
        const curve = curves[i % curves.length];
        let t = (elapsed * dustSpeeds[i] + i * 0.03) % 1;
        const pt = curve.getPoint(t);
        dustAttr.setXYZ(
          i,
          pt.x + Math.sin(elapsed + i) * 0.06,
          pt.y + Math.cos(elapsed * 1.3 + i) * 0.06,
          pt.z
        );
      }
      dustAttr.needsUpdate = true;

      busGroup.rotation.y = Math.sin(elapsed * 0.18) * 0.12;
      stars.rotation.y += delta * 0.02;
    }

    const targetX = pointer.x * 0.5;
    const targetY = 0.15 - pointer.y * 0.3;
    camera.position.x += (targetX - camera.position.x) * 0.05;
    camera.position.y += (targetY - camera.position.y) * 0.05;
    camera.lookAt(0, 0, 0);

    busGroup.rotation.x += (pointer.y * 0.08 - busGroup.rotation.x) * 0.04;
    busGroup.rotation.z += (-pointer.x * 0.06 - busGroup.rotation.z) * 0.04;

    if (composer) {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }

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
  })().catch(() => {
    // Logo load failed — canvas stays empty, page still works
  });
}
