import { useRef, useEffect } from 'react';
import * as THREE from 'three';

/**
 * Merge vertices that share the same position within a tolerance.
 * Inlined from Three.js BufferGeometryUtils because the
 * three/addons/ import path silently fails during Vite builds.
 */
function mergeVertices(geometry, tolerance = 1e-4) {
  tolerance = Math.max(tolerance, Number.EPSILON);
  const hashToIndex = {};
  const posAttr = geometry.getAttribute('position');
  const vertexCount = posAttr.count;
  let nextIndex = 0;
  const newIndices = [];
  const newPositions = [];

  for (let i = 0; i < vertexCount; i++) {
    const x = Math.round(posAttr.getX(i) / tolerance) * tolerance;
    const y = Math.round(posAttr.getY(i) / tolerance) * tolerance;
    const z = Math.round(posAttr.getZ(i) / tolerance) * tolerance;
    const hash = x + ',' + y + ',' + z;
    if (hash in hashToIndex) {
      newIndices.push(hashToIndex[hash]);
    } else {
      newPositions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      hashToIndex[hash] = nextIndex;
      newIndices.push(nextIndex);
      nextIndex++;
    }
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(new Float32Array(newPositions), 3));
  merged.setIndex(newIndices);
  return merged;
}

/**
 * Build a procedural environment map for PBR reflections.
 * Without an environment, MeshStandardMaterial has nothing to reflect
 * and metalness/roughness have almost no visible effect.
 */
function createEnvMap(renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.15, 0.17, 0.22);

  // Sky/ground gradient
  const hemiLight = new THREE.HemisphereLight(
    new THREE.Color(0.3, 0.35, 0.45),
    new THREE.Color(0.05, 0.05, 0.08),
    1.0
  );
  scene.add(hemiLight);

  // Bright spot for specular highlights
  const pointLight = new THREE.PointLight(0xffffff, 8, 0);
  pointLight.position.set(2, 3, 1);
  scene.add(pointLight);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();
  const envMap = pmrem.fromScene(scene, 0.04).texture;
  pmrem.dispose();
  return envMap;
}

/**
 * Renders mesh data (flat array of vertex positions) in a 3D viewport.
 * Supports orbit-style rotation via mouse drag and scroll-to-zoom.
 *
 * Rendering approach modeled after Xometry/Protolabs-style part viewers:
 * - Strong, even lighting so no face goes dark
 * - Environment map for realistic PBR reflections
 * - Neutral material color so geometry reads clearly
 * - Camera auto-targets the part center
 */
export default function ThreeViewer({ positions, color = '#5B8CB8', style }) {
  const mountRef = useRef(null);
  const stateRef = useRef({});

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    // ── Scene ──────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#1a1f2e');

    // ── Camera ─────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 10000);

    // ── Renderer ───────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.8;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    // ── Environment map for PBR reflections ────────────────
    const envMap = createEnvMap(renderer);
    scene.environment = envMap;

    // ── Grid ───────────────────────────────────────────────
    const grid = new THREE.GridHelper(200, 20, 0x2a3040, 0x1e2230);
    grid.material.opacity = 0.4;
    grid.material.transparent = true;
    scene.add(grid);

    // ── Lighting rig ──────────────────────────────────────
    // Strong ambient base — no face goes fully dark
    scene.add(new THREE.AmbientLight(0xc0c8d8, 0.8));

    // Hemisphere: sky/ground fill
    scene.add(new THREE.HemisphereLight(0xdce4f0, 0x3a3a4a, 0.9));

    // Key light — front-right-above
    const keyLight = new THREE.DirectionalLight(0xfff8f0, 1.4);
    keyLight.position.set(5, 8, 7);
    scene.add(keyLight);

    // Fill light — front-left, softens shadows
    const fillLight = new THREE.DirectionalLight(0xe8eeff, 0.7);
    fillLight.position.set(-6, 4, 5);
    scene.add(fillLight);

    // Rim light — back, defines edges
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
    rimLight.position.set(-2, 6, -8);
    scene.add(rimLight);

    // Bottom fill — prevents underside from going black
    const bottomLight = new THREE.DirectionalLight(0x8090a0, 0.3);
    bottomLight.position.set(0, -5, 0);
    scene.add(bottomLight);

    // ── Build mesh ────────────────────────────────────────
    let meshHeight = 40;

    if (positions && positions.length >= 9) {
      let geom = new THREE.BufferGeometry();
      const posArray = new Float32Array(positions);
      geom.setAttribute('position', new THREE.BufferAttribute(posArray, 3));

      // Merge duplicate STL vertices for smooth shading
      geom = mergeVertices(geom, 1e-4);
      geom.computeVertexNormals();

      // Center and scale to fit viewport
      geom.computeBoundingBox();
      const box = geom.boundingBox;
      const center = new THREE.Vector3();
      box.getCenter(center);
      const size = new THREE.Vector3();
      box.getSize(size);

      // Center X/Z, sit on grid at Y=0
      geom.translate(-center.x, -box.min.y, -center.z);

      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = maxDim > 0 ? 80 / maxDim : 1;
      geom.scale(scale, scale, scale);
      meshHeight = size.y * scale;

      // Material — neutral blue-gray with slight metallic sheen
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        metalness: 0.25,
        roughness: 0.45,
        side: THREE.DoubleSide,
        flatShading: false,
        envMap: envMap,
        envMapIntensity: 0.6,
      });
      scene.add(new THREE.Mesh(geom, mat));

      // Feature edges only on low-poly meshes (< 5000 tris)
      const triCount = geom.index
        ? geom.index.count / 3
        : posArray.length / 9;
      if (triCount < 5000) {
        const edges = new THREE.EdgesGeometry(geom, 25);
        const edgeMat = new THREE.LineBasicMaterial({
          color: 0x3a5575, opacity: 0.2, transparent: true,
        });
        scene.add(new THREE.LineSegments(edges, edgeMat));
      }
    } else {
      // Placeholder when no mesh data
      const geom = new THREE.BoxGeometry(40, 20, 40);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x4a6a8a, transparent: true, opacity: 0.15, wireframe: true,
      });
      scene.add(new THREE.Mesh(geom, mat));
    }

    // ── Camera orbit ──────────────────────────────────────
    let isDragging = false;
    let prevX = 0, prevY = 0;
    let theta = Math.PI * 0.3;
    let phi = Math.PI * 0.3;
    let radius = 130;
    const target = new THREE.Vector3(0, meshHeight * 0.35, 0);

    function updateCamera() {
      camera.position.x = target.x + radius * Math.sin(phi) * Math.cos(theta);
      camera.position.y = target.y + radius * Math.cos(phi);
      camera.position.z = target.z + radius * Math.sin(phi) * Math.sin(theta);
      camera.lookAt(target);
    }
    updateCamera();

    const onDown = (e) => { isDragging = true; prevX = e.clientX; prevY = e.clientY; };
    const onUp = () => { isDragging = false; };
    const onMove = (e) => {
      if (!isDragging) return;
      theta += (e.clientX - prevX) * 0.008;
      phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi - (e.clientY - prevY) * 0.008));
      prevX = e.clientX;
      prevY = e.clientY;
      updateCamera();
    };
    const onWheel = (e) => {
      e.preventDefault();
      radius = Math.max(40, Math.min(400, radius + e.deltaY * 0.15));
      updateCamera();
    };

    renderer.domElement.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onMove);
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

    // ── Render loop ───────────────────────────────────────
    let animId;
    function animate() {
      animId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();

    // ── Resize ────────────────────────────────────────────
    const onResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    stateRef.current = { renderer, animId };

    return () => {
      cancelAnimationFrame(animId);
      envMap.dispose();
      renderer.dispose();
      renderer.domElement.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('mousemove', onMove);
      renderer.domElement.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
    };
  }, [positions, color]);

  return <div ref={mountRef} style={{ width: '100%', height: '100%', ...style }} />;
}
