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

    const AGENTS = [
      { name: "Claude", color: 0x83f7c6, accent: "#83f7c6", pos: [-2.55, 1.0, 0], logo: "assets/logos/claude.svg" },
      { name: "Codex", color: 0x62d6ff, accent: "#62d6ff", pos: [-2.55, 0, 0], logo: "assets/logos/codex.svg" },
      { name: "Gemini", color: 0xffd166, accent: "#ffd166", pos: [-2.55, -1.0, 0], logo: "assets/logos/gemini.svg" },
      { name: "Grok", color: 0xff6b6b, accent: "#ff6b6b", pos: [2.55, 1.0, 0], logo: "assets/logos/grok.svg" },
      { name: "Cursor", color: 0xc084fc, accent: "#c084fc", pos: [2.55, 0, 0], logo: "assets/logos/cursor.svg" },
      { name: "Antigravity", color: 0x94a3b8, accent: "#94a3b8", pos: [2.55, -1.0, 0], logo: "assets/logos/antigravity.png" },
    ];

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    async function loadLogoCard(url, accent, rendererRef) {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });

      const size = 320;
      const el = document.createElement("canvas");
      el.width = el.height = size;
      const ctx = el.getContext("2d");

      roundRect(ctx, 18, 18, size - 36, size - 36, 36);
      ctx.fillStyle = "#0c1220";
      ctx.fill();

      ctx.shadowColor = accent;
      ctx.shadowBlur = 18;
      roundRect(ctx, 18, 18, size - 36, size - 36, 36);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.shadowBlur = 0;

      const pad = 62;
      const logoSize = size - pad * 2;
      ctx.drawImage(image, pad, pad, logoSize, logoSize);

      const texture = new THREE.CanvasTexture(el);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = rendererRef.capabilities.getMaxAnisotropy();
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      return texture;
    }

    function createGlowTexture() {
      const size = 128;
      const el = document.createElement("canvas");
      el.width = el.height = size;
      const ctx = el.getContext("2d");
      const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.4, "rgba(255,255,255,0.2)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
      const texture = new THREE.CanvasTexture(el);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    }

    function makeCurve(from, to) {
      const start = new THREE.Vector3(...from);
      const end = new THREE.Vector3(...to);
      const mid = start.clone().lerp(end, 0.5);
      mid.y += start.x < 0 ? 0.28 : -0.28;
      mid.z += 0.15;
      return new THREE.QuadraticBezierCurve3(start, mid, end);
    }

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x070b14, 0.04);

    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    camera.position.set(0, 0, 7.8);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const glowTexture = createGlowTexture();
    const busGroup = new THREE.Group();
    scene.add(busGroup);

    // Hub — clean wireframe + core glow
    const hubGroup = new THREE.Group();
    busGroup.add(hubGroup);

    const hubRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.52, 0.014, 12, 80),
      new THREE.MeshBasicMaterial({
        color: 0x22c55e,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    hubRing.rotation.x = Math.PI / 2;
    hubGroup.add(hubRing);

    const hubWire = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.38, 1),
      new THREE.MeshBasicMaterial({
        color: 0x83f7c6,
        wireframe: true,
        transparent: true,
        opacity: 0.65,
      })
    );
    hubGroup.add(hubWire);

    const hubCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 20, 20),
      new THREE.MeshBasicMaterial({
        color: 0x83f7c6,
        transparent: true,
        opacity: 0.95,
      })
    );
    hubGroup.add(hubCore);

    // Agent logo cards
    const nodes = [];
    const curves = [];
    const packets = [];
    const billboards = [];

    const logoTextures = await Promise.all(
      AGENTS.map((agent) => loadLogoCard(agent.logo, agent.accent, renderer))
    );

    for (let i = 0; i < AGENTS.length; i++) {
      const agent = AGENTS[i];
      const nodeGroup = new THREE.Group();

      const card = new THREE.Mesh(
        new THREE.PlaneGeometry(0.78, 0.78),
        new THREE.MeshBasicMaterial({
          map: logoTextures[i],
          transparent: true,
          depthWrite: true,
          toneMapped: false,
        })
      );
      nodeGroup.add(card);
      billboards.push(card);

      nodeGroup.position.set(...agent.pos);
      nodeGroup.userData = {
        base: agent.pos.slice(),
        color: agent.color,
        name: agent.name,
        card,
      };
      busGroup.add(nodeGroup);
      nodes.push(nodeGroup);

      const curve = makeCurve(agent.pos, [0, 0, 0]);
      curves.push(curve);

      const linePoints = curve.getPoints(64);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(linePoints);
      const line = new THREE.Line(
        lineGeo,
        new THREE.LineBasicMaterial({
          color: agent.color,
          transparent: true,
          opacity: 0.35,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      busGroup.add(line);

      if (!reducedMotion) {
        const packetCount = 2;
        for (let p = 0; p < packetCount; p++) {
          const packet = new THREE.Mesh(
            new THREE.SphereGeometry(0.035, 10, 10),
            new THREE.MeshBasicMaterial({
              color: agent.color,
              transparent: true,
              opacity: 0.9,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            })
          );
          packet.userData = {
            curve,
            speed: 0.18 + p * 0.1,
            offset: p / packetCount,
            dir: agent.pos[0] < 0 ? 1 : -1,
          };
          busGroup.add(packet);
          packets.push(packet);
        }
      }
    }

    // Subtle starfield
    const starCount = reducedMotion ? 60 : 100;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      starPos[i * 3] = (Math.random() - 0.5) * 12;
      starPos[i * 3 + 1] = (Math.random() - 0.5) * 7;
      starPos[i * 3 + 2] = (Math.random() - 0.5) * 8 - 3;
    }
    const stars = new THREE.Points(
      new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(starPos, 3)),
      new THREE.PointsMaterial({
        map: glowTexture,
        size: 0.035,
        transparent: true,
        opacity: 0.35,
        color: 0x64748b,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      })
    );
    scene.add(stars);

    scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    let composer = null;
    if (!isMobile) {
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.35, 0.42);
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

      // Billboards always face camera — keeps SVG logos crisp & readable
      for (const card of billboards) {
        card.lookAt(camera.position);
      }

      if (!reducedMotion) {
        hubWire.rotation.y += delta * 0.4;
        hubWire.rotation.x = Math.sin(elapsed * 0.45) * 0.1;
        hubRing.rotation.z += delta * 0.15;
        hubCore.scale.setScalar(1 + Math.sin(elapsed * 2) * 0.1);

        for (const nodeGroup of nodes) {
          const [bx, by, bz] = nodeGroup.userData.base;
          const phase = elapsed * 1.2 + bx;
          nodeGroup.position.x = bx + Math.sin(phase) * 0.03;
          nodeGroup.position.y = by + Math.cos(phase * 1.1) * 0.04;
          nodeGroup.position.z = bz;
        }

        for (const packet of packets) {
          const { curve, speed, offset, dir } = packet.userData;
          let t = (elapsed * speed + offset) % 1;
          if (dir < 0) t = 1 - t;
          packet.position.copy(curve.getPoint(t));
        }

        busGroup.rotation.y = Math.sin(elapsed * 0.12) * 0.08;
        stars.rotation.y += delta * 0.015;
      }

      camera.position.x += (pointer.x * 0.35 - camera.position.x) * 0.04;
      camera.position.y += (-pointer.y * 0.2 - camera.position.y) * 0.04;
      camera.position.z = 7.8;
      camera.lookAt(0, 0, 0);

      busGroup.rotation.x += (pointer.y * 0.05 - busGroup.rotation.x) * 0.03;
      busGroup.rotation.z += (-pointer.x * 0.04 - busGroup.rotation.z) * 0.03;

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
