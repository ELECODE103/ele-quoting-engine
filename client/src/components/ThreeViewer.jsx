import { useRef, useEffect } from 'react'; // NORDMFG_BUILD_V3
import * as THREE from 'three';

/**
 * Merge vertices that share the same position within a tolerance.
 * Inlined from Three.js BufferGeometryUtils to avoid import resolution issues.
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
 * Renders mesh data (flat array of vertex positions) in a 3D viewport.
 * Supports orbit-style rotation via mouse drag.
 */
export default function ThreeViewer({ positions, color = '#4F8CFF', style }) {
  const mountRef = useRef(null);
  const stateRef = useRef({});

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth;
    const height = container.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#080C14');

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const grid = new THREE.GridHelper(200, 20, 0x1E3A5F, 0x111827);
    scene.add(grid);

    scene.add(new THREE.AmbientLight(0x8090b0, 0.5));
    scene.add(new THREE.HemisphereLight(0xb0c4de, 0x1a1a2e, 0.6));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);
    const dirLight2 = new THREE.DirectionalLight(0x4F8CFF, 0.4);
    dirLight2.position.set(-5, -3, -5);
    scene.add(dirLight2);
    const dirLight3 = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight3.position.set(-3, 5, -8);
    scene.add(dirLight3);

    if (positions && positions.length >= 9) {
      let geom = new THREE.BufferGeometry();
      const posArray = new Float32Array(positions);
      geom.setAttribute('position', new THREE.BufferAttribute(posArray, 3));

      // Merge duplicate vertices for smooth shading on STL meshes
      geom = mergeVertices(geom, 1e-4);
      geom.computeVertexNormals();

      geom.computeBoundingBox();
      const box = geom.boundingBox;
      const center = new THREE.Vector3();
      box.getCenter(center);
      const size = new THREE.Vector3();
      box.getSize(size);
      geom.translate(-center.x, -box.min.y, -center.z);

      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = maxDim > 0 ? 80 / maxDim : 1;
      geom.scale(scale, scale, scale);

      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        metalness: 0.15,
        roughness: 0.55,
        side: THREE.DoubleSide,
        flatShading: false,
      });
      scene.add(new THREE.Mesh(geom, mat));

      const triCount = geom.index ? geom.index.count / 3 : posArray.length / 9;
      if (triCount < 5000) {
        const edges = new THREE.EdgesGeometry(geom, 30);
        const edgeMat = new THREE.LineBasicMaterial({
          color: new THREE.Color(color), opacity: 0.25, transparent: true,
        });
        scene.add(new THREE.LineSegments(edges, edgeMat));
      }
    } else {
      const geom = new THREE.BoxGeometry(40, 20, 40);
      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(color), transparent: true, opacity: 0.3, wireframe: true,
      });
      scene.add(new THREE.Mesh(geom, mat));
    }

    camera.position.set(80, 60, 80);
    camera.lookAt(0, 0, 0);

    let isDragging = false;
    let prevX = 0, prevY = 0;
    let theta = Math.PI / 4, phi = Math.PI / 4;
    let radius = 120;

    function updateCamera() {
      camera.position.x = radius * Math.sin(phi) * Math.cos(theta);
      camera.position.y = radius * Math.cos(phi);
      camera.position.z = radius * Math.sin(phi) * Math.sin(theta);
      camera.lookAt(0, 0, 0);
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
      radius = Math.max(40, Math.min(400, radius + e.deltaY * 0.1));
      updateCamera();
    };

    renderer.domElement.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('mousemove', onMove);
    renderer.domElement.addEventListener('wheel', onWheel);

    let animId;
    function animate() {
      animId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();

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
