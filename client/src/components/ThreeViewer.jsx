import { useRef, useEffect } from 'react';
import * as THREE from 'three';

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

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#080C14');

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 10000);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    // Grid helper
    const grid = new THREE.GridHelper(200, 20, 0x1E3A5F, 0x111827);
    scene.add(grid);

    // Lights
    const ambient = new THREE.AmbientLight(0x404060, 0.6);
    scene.add(ambient);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 7);
    scene.add(dirLight);
    const dirLight2 = new THREE.DirectionalLight(0x4F8CFF, 0.3);
    dirLight2.position.set(-5, -3, -5);
    scene.add(dirLight2);

    // Build mesh from positions
    if (positions && positions.length >= 9) {
      const geom = new THREE.BufferGeometry();
      const posArray = new Float32Array(positions);
      geom.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
      geom.computeVertexNormals();

      // Center and scale to fit
      geom.computeBoundingBox();
      const box = geom.boundingBox;
      const center = new THREE.Vector3();
      box.getCenter(center);
      geom.translate(-center.x, -center.y, -center.z);

      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = maxDim > 0 ? 80 / maxDim : 1;
      geom.scale(scale, scale, scale);

      // Main mesh
      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(color),
        specular: 0x222244,
        shininess: 40,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geom, mat);
      scene.add(mesh);

      // Wireframe overlay
      const wire = new THREE.WireframeGeometry(geom);
      const lineMat = new THREE.LineBasicMaterial({ color: new THREE.Color(color), opacity: 0.15, transparent: true });
      const wireframe = new THREE.LineSegments(wire, lineMat);
      scene.add(wireframe);

      // Edges for visual clarity
      const edges = new THREE.EdgesGeometry(geom, 30);
      const edgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(color), opacity: 0.5, transparent: true });
      const edgeLines = new THREE.LineSegments(edges, edgeMat);
      scene.add(edgeLines);
    } else {
      // Placeholder cube when no mesh data
      const geom = new THREE.BoxGeometry(40, 20, 40);
      const mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: 0.3,
        wireframe: true,
      });
      scene.add(new THREE.Mesh(geom, mat));
    }

    // Position camera
    camera.position.set(80, 60, 80);
    camera.lookAt(0, 0, 0);

    // Simple orbit controls (mouse drag)
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
      const dx = e.clientX - prevX;
      const dy = e.clientY - prevY;
      theta += dx * 0.008;
      phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi - dy * 0.008));
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

    // Render loop
    let animId;
    function animate() {
      animId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();

    // Resize
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
