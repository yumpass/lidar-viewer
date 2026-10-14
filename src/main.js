
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import "./style.css";

// ============================================================
// CONFIGURACION
// ============================================================

// Sustituye por la URL real de tu objeto en Amazon S3.
// No uses la URL s3://; debe ser una URL HTTPS.
const LAS_URL =
  "/data/Parcela.las";

const EXPECTED_POINT_FORMAT = 6;
const EXPECTED_RECORD_LENGTH = 54;
const CHUNK_BYTES = 8 * 1024 * 1024;

// ============================================================
// INTERFAZ
// ============================================================

document.body.innerHTML = `
  <div id="toolbar">
    <strong>Visor LiDAR — LAS 1.4</strong>

    <label for="colorMode">Color:</label>
    <select id="colorMode">
      <option value="height">Altura Z</option>
      <option value="classification">Clasificación</option>
      <option value="intensity">Intensidad</option>
      <option value="tree">Tree_ID</option>
    </select>

    <span id="status">Preparando visor...</span>
  </div>

  <div id="viewer"></div>
`;

const viewer = document.querySelector("#viewer");
const status = document.querySelector("#status");
const colorMode = document.querySelector("#colorMode");

// ============================================================
// THREE.JS
// ============================================================

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111820);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.01,
  100000
);

camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: "high-performance"
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
viewer.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const cloudMaterial = new THREE.PointsMaterial({
  size: 0.12,
  sizeAttenuation: true,
  vertexColors: true
});

let cloud = null;
let pointData = null;
let center = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================
// SOLICITUDES HTTP RANGE
// ============================================================

async function readRange(start, end) {
  const response = await fetch(LAS_URL, {
    headers: {
      Range: `bytes=${start}-${end}`
    }
  });

  if (response.status !== 206) {
    throw new Error(
      `S3 no devolvió HTTP 206 para Range. ` +
      `Respuesta: ${response.status}. ` +
      `Verifica CORS y soporte de solicitudes de rango.`
    );
  }

  const contentRange = response.headers.get("Content-Range");

  if (!contentRange) {
    throw new Error(
      "Falta Content-Range. Revisa ExposeHeaders en CORS."
    );
  }

  const match = contentRange.match(
    /^bytes (\d+)-(\d+)\/(\d+)$/
  );

  if (!match) {
    throw new Error(`Content-Range inválido: ${contentRange}`);
  }

  if (Number(match[1]) !== start || Number(match[2]) !== end) {
    throw new Error("S3 devolvió un rango diferente al solicitado.");
  }

  const buffer = await response.arrayBuffer();

  if (buffer.byteLength !== end - start + 1) {
    throw new Error("Longitud del bloque recibida incorrecta.");
  }

  return {
    buffer,
    totalSize: Number(match[3])
  };
}

// ============================================================
// LECTURA DE VLR: DIMENSIONES ADICIONALES
// ============================================================

function parseExtraBytesVLR(buffer) {
  const view = new DataView(buffer);
  const decoder = new TextDecoder();

  const text = (offset, length) =>
    decoder.decode(
      new Uint8Array(buffer, offset, length)
    ).replace(/\0/g, "").trim();

  const dimensions = [];
  let pos = 0;

  while (pos + 54 <= buffer.byteLength) {
    const userId = text(pos + 2, 16);
    const recordId = view.getUint16(pos + 18, true);
    const recordLength = view.getUint16(pos + 20, true);

    const dataStart = pos + 54;
    const dataEnd = dataStart + recordLength;

    if (dataEnd > buffer.byteLength) break;

    if (userId === "LASF_Spec" && recordId === 4) {
      // Cada descriptor Extra Bytes ocupa 192 bytes.
      for (
        let p = dataStart;
        p + 192 <= dataEnd;
        p += 192
      ) {
        const type = view.getUint8(p + 2);
        const name = text(p + 4, 32);

        // Tipos escalares numéricos LAS Extra Bytes.
        const types = {
          1: { size: 1, read: "getUint8" },
          2: { size: 1, read: "getInt8" },
          3: { size: 2, read: "getUint16" },
          4: { size: 2, read: "getInt16" },
          5: { size: 4, read: "getUint32" },
          6: { size: 4, read: "getInt32" },
          7: { size: 8, read: "getBigUint64" },
          8: { size: 8, read: "getBigInt64" },
          9: { size: 4, read: "getFloat32" },
          10: { size: 8, read: "getFloat64" }
        };

        if (type >= 1 && type <= 10) {
          dimensions.push({
            name,
            type,
            size: types[type].size,
            read: types[type].read
          });
        }
      }
    }

    pos = dataEnd;
  }

  // En el formato 6, los bytes adicionales comienzan
  // inmediatamente después de los primeros 30 bytes.
  let offset = 30;

  for (const dim of dimensions) {
    dim.offset = offset;
    offset += dim.size;
  }

  return dimensions;
}

// ============================================================
// CARGA DEL LAS ORIGINAL
// ============================================================

async function loadLAS() {
  status.textContent = "Leyendo cabecera LAS...";

  // El bloque público de cabecera LAS 1.4 ocupa 375 bytes.
  const first = await readRange(0, 374);
  const headerBuffer = first.buffer;
  const h = new DataView(headerBuffer);

  const signature = new TextDecoder().decode(
    new Uint8Array(headerBuffer, 0, 4)
  );

  if (signature !== "LASF") {
    throw new Error("La firma del archivo no es LASF.");
  }

  const major = h.getUint8(24);
  const minor = h.getUint8(25);
  const headerSize = h.getUint16(94, true);
  const pointOffset = h.getUint32(96, true);
  const pointFormatByte = h.getUint8(104);
  const pointFormat = pointFormatByte & 0x3f;
  const compressed = (pointFormatByte & 0x80) !== 0;
  const recordLength = h.getUint16(105, true);

  const scaleX = h.getFloat64(131, true);
  const scaleY = h.getFloat64(139, true);
  const scaleZ = h.getFloat64(147, true);

  const offsetX = h.getFloat64(155, true);
  const offsetY = h.getFloat64(163, true);
  const offsetZ = h.getFloat64(171, true);

  // LAS 1.4: contador extendido de puntos, uint64.
  const count64 = h.getBigUint64(247, true);
  const pointCount = Number(count64);

  if (major !== 1 || minor !== 4) {
    throw new Error(`Versión LAS inesperada: ${major}.${minor}`);
  }

  if (compressed) {
    throw new Error(
      "El archivo tiene puntos comprimidos. " +
      "Este lector procesa LAS sin compresión."
    );
  }

  if (pointFormat !== EXPECTED_POINT_FORMAT) {
    throw new Error(
      `Formato de punto ${pointFormat}; ` +
      `se esperaba ${EXPECTED_POINT_FORMAT}.`
    );
  }

  if (recordLength !== EXPECTED_RECORD_LENGTH) {
    throw new Error(
      `Longitud de registro inesperada: ${recordLength} bytes.`
    );
  }

  if (
    !Number.isSafeInteger(pointCount) ||
    pointCount <= 0
  ) {
    throw new Error("Número de puntos inválido.");
  }

  if (
    headerSize < 375 ||
    pointOffset < headerSize ||
    pointOffset + pointCount * recordLength > first.totalSize
  ) {
    throw new Error("La cabecera o los límites del LAS son inválidos.");
  }

  const numberOfVLRs = h.getUint32(100, true);

  // Leer VLR hasta el comienzo de los registros de puntos.
  const vlrLength = pointOffset - headerSize;
  let dimensions = [];

  if (vlrLength > 0) {
    const vlrs = await readRange(
      headerSize,
      pointOffset - 1
    );

    dimensions = parseExtraBytesVLR(vlrs.buffer);
  }

  const treeDimension = dimensions.find(
    d => d.name.toLowerCase() === "tree_id"
  );

  // El archivo contiene 551.974 puntos: unos 30 MB.
  // Las solicitudes son secuenciales y cada bloque está
  // alineado con los límites de los registros LAS.
  const chunkPoints = Math.max(
    1,
    Math.floor(CHUNK_BYTES / recordLength)
  );

  const positions = new Float32Array(pointCount * 3);
  const intensities = new Uint16Array(pointCount);
  const classifications = new Uint8Array(pointCount);

  const treeIds = treeDimension
    ? new Float64Array(pointCount)
    : null;

  let minZ = Infinity;
  let maxZ = -Infinity;

  for (
    let startPoint = 0;
    startPoint < pointCount;
    startPoint += chunkPoints
  ) {
    const n = Math.min(
      chunkPoints,
      pointCount - startPoint
    );

    const byteStart = pointOffset + startPoint * recordLength;
    const byteEnd = byteStart + n * recordLength - 1;

    const chunk = await readRange(byteStart, byteEnd);
    const v = new DataView(chunk.buffer);

    for (let j = 0; j < n; j++) {
      const src = j * recordLength;
      const i = startPoint + j;

      const x = v.getInt32(src, true) * scaleX + offsetX;
      const y = v.getInt32(src + 4, true) * scaleY + offsetY;
      const z = v.getInt32(src + 8, true) * scaleZ + offsetZ;

      positions[3 * i] = x;
      positions[3 * i + 1] = y;
      positions[3 * i + 2] = z;

      intensities[i] = v.getUint16(src + 12, true);
      classifications[i] = v.getUint8(src + 16);

      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;

      if (treeIds) {
        const raw = v[treeDimension.read](
          src + treeDimension.offset,
          true
        );

        treeIds[i] = Number(raw);
      }
    }

    status.textContent =
      `Cargando ${Math.min(startPoint + n, pointCount).toLocaleString()} ` +
      `/ ${pointCount.toLocaleString()} puntos`;
  }

  // Centrar coordenadas para mejorar la precisión de Three.js.
  const minX = h.getFloat64(179, true);
  const maxX = h.getFloat64(187, true);
  const minY = h.getFloat64(195, true);
  const maxY = h.getFloat64(203, true);

  center.set(
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2
  );

  for (let i = 0; i < pointCount; i++) {
    positions[3 * i] -= center.x;
    positions[3 * i + 1] -= center.y;
    positions[3 * i + 2] -= center.z;
  }

  pointData = {
    positions,
    intensities,
    classifications,
    treeIds,
    minZ,
    maxZ
  };

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3)
  );

  cloud = new THREE.Points(geometry, cloudMaterial);
  scene.add(cloud);

  const width = maxX - minX;
  const depth = maxY - minY;
  const maxDimension = Math.max(width, depth, maxZ - minZ);

  camera.position.set(
    maxDimension * 0.8,
    -maxDimension * 1.1,
    maxDimension * 0.8
  );

  camera.near = Math.max(0.01, maxDimension / 10000);
  camera.far = maxDimension * 100;
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.update();

  colorMode.addEventListener("change", updateColors);
  updateColors();

  status.textContent =
    `${pointCount.toLocaleString()} puntos · ` +
    `LAS ${major}.${minor} · Formato ${pointFormat} · ` +
    `VLR: ${numberOfVLRs} · ` +
    `Tree_ID: ${treeIds ? "disponible" : "sin descriptor válido"}`;

  console.log({
    version: `${major}.${minor}`,
    pointFormat,
    recordLength,
    pointCount,
    pointOffset,
    dimensions
  });
}

// ============================================================
// COLORES POR ATRIBUTO
// ============================================================

function updateColors() {
  if (!pointData || !cloud) return;

  const {
    positions,
    intensities,
    classifications,
    treeIds,
    minZ,
    maxZ
  } = pointData;

  const count = intensities.length;
  const colors = new Float32Array(count * 3);

  const mode = colorMode.value;

  if (mode === "tree" && !treeIds) {
    status.textContent =
      "Tree_ID no está disponible como dimensión Extra Bytes.";
    return;
  }

  const zRange = maxZ - minZ || 1;

  for (let i = 0; i < count; i++) {
    let r = 0.8;
    let g = 0.8;
    let b = 0.8;

    if (mode === "height") {
      const t = Math.max(
        0,
        Math.min(1, (positions[3 * i + 2] + center.z - minZ) / zRange)
      );

      r = t;
      g = 0.25 + 0.65 * (1 - Math.abs(2 * t - 1));
      b = 1 - t;
    } else if (mode === "intensity") {
      const t = intensities[i] / 65535;
      r = g = b = t;
    } else if (mode === "classification") {
      const c = classifications[i];

      // Colores ilustrativos por clase.
      const palette = {
        0: [0.65, 0.65, 0.65],
        1: [0.8, 0.8, 0.8],
        2: [0.45, 0.75, 0.3],
        3: [0.2, 0.85, 0.3],
        4: [0.1, 0.7, 0.5],
        5: [0.05, 0.45, 0.2],
        6: [0.9, 0.35, 0.15],
        7: [1.0, 0.8, 0.1]
      };

      [r, g, b] = palette[c] || [0.7, 0.4, 0.9];
    } else if (mode === "tree") {
      const id = treeIds[i];
      const hue = ((id * 0.61803398875) % 1 + 1) % 1;

      const color = new THREE.Color().setHSL(hue, 0.8, 0.55);
      r = color.r;
      g = color.g;
      b = color.b;
    }

    colors[3 * i] = r;
    colors[3 * i + 1] = g;
    colors[3 * i + 2] = b;
  }

  cloud.geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(colors, 3)
  );

  cloud.geometry.attributes.color.needsUpdate = true;
}

loadLAS().catch(error => {
  console.error("Error cargando LAS:", error);
  status.textContent = `Error: ${error.message}`;
});
