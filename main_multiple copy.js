// ---- Imports ----
import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls'; // keep path; e.g. 'three/examples/jsm/controls/OrbitControls.js'

// ---- Globals ----
let scene, camera, renderer, frameSlider, playButton, stopButton, timestampElement;
let frames = {};
let currentFrame = 0;
let animationInterval;
const scaleFactor = 1;
const timestampList = [];
const skeletonGroup = new THREE.Group();

// ---- Scene / Camera / Renderer ----
scene = new THREE.Scene();
scene.background = new THREE.Color(0xeeeeee);

camera = new THREE.PerspectiveCamera(13, window.innerWidth / window.innerHeight, 0.5, 350);
camera.position.set(0, 13, -18);
camera.updateProjectionMatrix();

renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// ---- Lights (stabilized) ----
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x8d8d8d, 1.5);
hemiLight.position.set(0, 50, 0);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(-10, 15, 2);
dirLight.castShadow = false;
scene.add(dirLight);

scene.add(new THREE.AmbientLight(0xffffff, 0.5)); // baseline fill

// ---- Helpers / Controls ----
const gridHelper = new THREE.GridHelper(10, 10);
gridHelper.position.set(0, -1.5, 0);
scene.add(gridHelper);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enablePan = true;
controls.enableZoom = true;
controls.minDistance = 1;
controls.maxDistance = 45;
controls.screenSpacePanning = true;
controls.update();

skeletonGroup.rotation.x = Math.PI / 20;
scene.add(skeletonGroup);

// ---- Skeleton definitions ----
const jointNames = [
  'Head','Neck','SpineBase','SpineShoulder',
  'ShoulderLeft','ElbowLeft','ShoulderRight','ElbowRight',
  'HipLeft','KneeLeft','HipRight','KneeRight',
  'WristRight','WristLeft','HandLeft','HandRight',
  'ThumbRight','ThumbLeft','HandTipRight','HandTipLeft',
  'AnkleLeft','AnkleRight'
];

const boneConnections = [
  ['SpineShoulder','Neck'], ['SpineShoulder','SpineBase'], ['Neck','Head'],
  ['ShoulderLeft','ElbowLeft'], ['ElbowLeft','WristLeft'],
  ['ShoulderRight','ElbowRight'], ['ElbowRight','WristRight'],
  ['HipLeft','KneeLeft'], ['KneeLeft','AnkleLeft'],
  ['HipRight','KneeRight'], ['KneeRight','AnkleRight'],
  ['ShoulderLeft','SpineShoulder'], ['ShoulderRight','SpineShoulder'],
  ['HipLeft','SpineBase'], ['HipRight','SpineBase'],
  ['WristRight','HandRight'], ['HandRight','ThumbRight'], ['HandRight','HandTipRight'],
  ['WristLeft','HandLeft'], ['HandLeft','ThumbLeft'], ['HandLeft','HandTipLeft'],
];

// ---- Materials / Geometries (created once) ----
const JOINT_MAT = new THREE.MeshStandardMaterial({ color: 0xAD43EA, roughness: 0.7, metalness: 0.1 });
const BONE_MAT  = new THREE.MeshPhysicalMaterial({ color: 0xAD43EA, roughness: 0.2, metalness: 0.2, clearcoat: 0.8 });
const HEAD_MAT  = new THREE.MeshStandardMaterial({ color: 0xAD43EA, roughness: 0.7, metalness: 0.1 });
const NOSE_MAT  = new THREE.MeshStandardMaterial({ color: 0x43EA79 });

const JOINT_GEO = new THREE.SphereGeometry(0.02, 16, 16);
const BONE_GEO  = new THREE.CylinderGeometry(0.02, 0.02, 1, 16);
const HEAD_GEO  = (() => {
  const g = new THREE.CapsuleGeometry(0.15/2, 0.2 - 0.15, 8, 8);
  g.scale(1, 1, 0.05/0.15); // stretch Z for a “head” look
  return g;
})();
const NOSE_GEO  = new THREE.CylinderGeometry(0.01, 0.01, 0.1, 16);

// ---- Skeleton pool (reuse meshes) ----
const skeletonPool = new Map(); // BodyId -> { group, joints, bones, head }

function createSkeleton(bodyId) {
  const group = new THREE.Group();
  group.name = `skeleton:${bodyId}`;

  const joints = {};
  const bones  = {};

  // joints
  for (const j of jointNames) {
    const m = new THREE.Mesh(JOINT_GEO, JOINT_MAT);
    m.frustumCulled = false;
    joints[j] = m;
    group.add(m);
  }

  // head + nose (replace default head sphere)
  const head = new THREE.Mesh(HEAD_GEO, HEAD_MAT);
  head.frustumCulled = false;
  const nose = new THREE.Mesh(NOSE_GEO, NOSE_MAT);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0, 0.04);
  head.add(nose);
  group.remove(joints['Head']);
  joints['Head'] = head;
  group.add(head);

  // bones
  for (const [a, b] of boneConnections) {
    const cyl = new THREE.Mesh(BONE_GEO, BONE_MAT);
    cyl.frustumCulled = false;
    bones[`${a}-${b}`] = cyl;
    group.add(cyl);
  }

  skeletonGroup.add(group);
  return { group, joints, bones, head };
}

function getSkeleton(bodyId) {
  let sk = skeletonPool.get(bodyId);
  if (!sk) {
    sk = createSkeleton(bodyId);
    skeletonPool.set(bodyId, sk);
  }
  return sk;
}

// ---- Frame update (reuse only; no recreate) ----
const UP = new THREE.Vector3(0, 1, 0);
const tmpStart = new THREE.Vector3();
const tmpEnd   = new THREE.Vector3();
const tmpMid   = new THREE.Vector3();
const tmpDir   = new THREE.Vector3();
const tmpAxis  = new THREE.Vector3();

function updateSkeletons(skeletonsForTimestamp) {
  if (!skeletonsForTimestamp || skeletonsForTimestamp.length === 0) return;

  // hide all bodies; enable only those present this frame
  for (const sk of skeletonPool.values()) sk.group.visible = false;

  for (const { BodyId, Joints } of skeletonsForTimestamp) {
    const sk = getSkeleton(BodyId);
    const { joints, bones, head } = sk;

    // joints positions
    for (const jName in Joints) {
      const d = Joints[jName];
      const m = joints[jName];
      if (m && d) m.position.set(d.X * scaleFactor, d.Y * scaleFactor, d.Z * scaleFactor);
    }

    // bones transforms
    for (const [a, b] of boneConnections) {
      const bone = bones[`${a}-${b}`];
      const ja = joints[a];
      const jb = joints[b];
      if (!bone || !ja || !jb) continue;

      tmpStart.copy(ja.position);
      tmpEnd.copy(jb.position);

      // midpoint
      tmpMid.addVectors(tmpStart, tmpEnd).multiplyScalar(0.5);
      bone.position.copy(tmpMid);

      // orientation
      tmpDir.subVectors(tmpEnd, tmpStart).normalize();
      tmpAxis.crossVectors(UP, tmpDir).normalize();
      const angle = Math.acos(THREE.MathUtils.clamp(UP.dot(tmpDir), -1, 1));
      bone.quaternion.setFromAxisAngle(tmpAxis, angle);

      // length
      const dist = tmpStart.distanceTo(tmpEnd);
      bone.scale.set(1, dist / BONE_GEO.parameters.height, 1);
    }

    // head yaw stabilization
    const neck = joints['Neck'];
    const headJoint = joints['Head'];
    const lShoulder = joints['ShoulderLeft'];
    const rShoulder = joints['ShoulderRight'];
    if (neck && headJoint && lShoulder && rShoulder) {
      const neckToHead = tmpDir.subVectors(headJoint.position, neck.position).normalize();
      const bodyLR = new THREE.Vector3().subVectors(rShoulder.position, lShoulder.position).normalize();
      const forwardBody = new THREE.Vector3(-bodyLR.z, 0, bodyLR.x).normalize();
      const finalDir = neckToHead.clone().lerp(forwardBody, 0.1).normalize();
      const yaw = Math.atan2(finalDir.x, finalDir.z);
      head.rotation.set(0, yaw, 0);
    }

    sk.group.visible = true;
  }

  const timestamp = skeletonsForTimestamp[0].Timestamp;
  console.log(skeletonsForTimestamp)

// Convert ISO string into a Date object
const date = new Date(timestamp);

// Format into a readable string
const formatted = date.toLocaleString("en-GB", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

if (timestampElement) {
  timestampElement.textContent = `Timestamp: ${formatted}`;
}
  
  
}

// ---- Data organization ----
function organizeDataByTimestamp(skeletonData) {
  const organizedData = {};
  for (const skeleton of skeletonData) {
    const { Timestamp, BodyId, Joints } = skeleton;
    if (!organizedData[Timestamp]) organizedData[Timestamp] = [];
    organizedData[Timestamp].push({ Timestamp, BodyId, Joints });
    if (!timestampList.includes(Timestamp)) timestampList.push(Timestamp);
  }
  return organizedData;
}

// ---- Static models (unchanged) ----
function createClock() {
    const bodyGeometry = new THREE.BoxGeometry(0.2, 3, 0.5); // Tall rectangle
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xFFFFFF });
    const clockBody = new THREE.Mesh(bodyGeometry, bodyMaterial);

    clockBody.rotation.y = THREE.MathUtils.degToRad(20);
    return clockBody;
}

function createHarp() {
    const harpGroup = new THREE.Group();

    const bodyGeometry = new THREE.BoxGeometry(1, 0.1, 1.5); 
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x4f290e  });
    const harpBody = new THREE.Mesh(bodyGeometry, bodyMaterial);

    // Harp legs (smaller boxes)
    const legGeometry = new THREE.BoxGeometry(0.3, 0.5, 0.1); // Adjusted leg size
    const legMaterial = new THREE.MeshStandardMaterial({ color: 0x4f290e });

    const harpLeg1 = new THREE.Mesh(legGeometry, legMaterial);
    const harpLeg2 = harpLeg1.clone();
    const harpLeg3 = harpLeg1.clone();
    const harpLeg4 = harpLeg1.clone();

    // Position the legs correctly under the body
    harpLeg1.position.set(-0.1, -0.3, 0.6);  // Front-left
    harpLeg2.position.set(0.1, -0.3, 0.6);   // Front-right
    harpLeg3.position.set(-0.1, -0.3, -0.6); // Back-left
    harpLeg4.position.set(0.1, -0.3, -0.6);  // Back-right

    // Add the body and legs to the harp group
    harpGroup.add(harpBody);
    harpGroup.add(harpLeg1, harpLeg2, harpLeg3, harpLeg4);

    return harpGroup;
}

// Function to create a piano
function createPiano() {
    const pianoGroup = new THREE.Group();

    // Piano body (rectangle)
    const bodyGeometry = new THREE.BoxGeometry(0.6, 0.2, 1.5); // Main body of the piano
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xffcc99 }); // Brown color
    const pianoBody = new THREE.Mesh(bodyGeometry, bodyMaterial);

    // Piano legs (small boxes)
    const legGeometry = new THREE.BoxGeometry(0.03, 0.6, 0.03); // Legs
    const legMaterial = new THREE.MeshStandardMaterial({ color: 0xffcc99 });
    const pianoLeg1 = new THREE.Mesh(legGeometry, legMaterial);
    const pianoLeg2 = pianoLeg1.clone();
    const pianoLeg3 = pianoLeg1.clone();
    const pianoLeg4 = pianoLeg1.clone();

    // Position the legs under the piano body
    pianoLeg1.position.set(-0.27, -0.3, 0.7);
    pianoLeg2.position.set(0.27,-0.3, 0.7);

    pianoLeg3.position.set(0.27, -0.3, -0.7);
    pianoLeg4.position.set(-0.27, -0.3, -0.7);

    // Add body and legs to the piano group
    pianoGroup.add(pianoBody);
    pianoGroup.add(pianoLeg2, pianoLeg1, pianoLeg3, pianoLeg4);
    pianoGroup.rotation.y = THREE.MathUtils.degToRad(10);


    return pianoGroup;
}

function addModelsToScene(scene) {
    const clock = createClock();
    clock.position.set(-1, 0, 3); clock.rotateOnAxis=Math.PI/36; scene.add(clock);
  
    const piano1 = createPiano();
    piano1.position.set(-1.2, -0.90, 1.5);   scene.add(piano1);

    const harp= createHarp();
    harp.position.set(2, -0.95, 1.0); scene.add(harp);
}
addModelsToScene(scene);

// ---- Physical camera + FOV triangle (as in your code) ----
const cameraGeometry = new THREE.BoxGeometry(0.35, 0.1, 0.1);
const cameraMaterial = new THREE.MeshStandardMaterial({ color: 0x000000 });
const physicalCamera = new THREE.Mesh(cameraGeometry, cameraMaterial);
physicalCamera.position.set(0, 0, 0);
physicalCamera.rotation.y = Math.PI;
scene.add(physicalCamera);

const fovAngle = THREE.MathUtils.degToRad(70.6);
const distance = 4.5;
const halfBase = Math.tan(fovAngle / 2) * distance;
const fovTriangleGeometry = new THREE.BufferGeometry();
fovTriangleGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
  0, 0, 0,  -halfBase, 0, -distance,  halfBase, 0, -distance
]), 3));
const fovTriangleMaterial = new THREE.MeshBasicMaterial({ color: 0xB5B4D5, opacity: 0.85, transparent: true, side: THREE.DoubleSide });
const fovTriangle = new THREE.Mesh(fovTriangleGeometry, fovTriangleMaterial);
fovTriangle.position.set(0, -2, 0);
fovTriangle.rotation.y = Math.PI;
scene.add(fovTriangle);

// ---- UI wiring ----
let isPlaying = false;

function playAnimation() {
  isPlaying = true;
  clearInterval(animationInterval);
  animationInterval = setInterval(() => {
    currentFrame = (currentFrame + 1) % timestampList.length;
    if (frameSlider) frameSlider.value = currentFrame;
    updateSkeletons(frames[timestampList[currentFrame]]);
  }, 45);
}

function pauseAnimation() {
  isPlaying = false;
  clearInterval(animationInterval);
}

function stopAnimation() {
  isPlaying = false;
  clearInterval(animationInterval);
  currentFrame = 0;
  if (frameSlider) frameSlider.value = currentFrame;
  updateSkeletons(frames[timestampList[currentFrame]]);
  if (playButton) playButton.classList.remove('active');
}

function togglePlayPause() {
  const btn = document.getElementById('playPauseButton');
  const icon = btn?.querySelector('svg path');
  if (!btn || !icon) return;
  if (isPlaying) {
    pauseAnimation();
    btn.classList.remove('active');
    btn.innerHTML = `<svg class="svg-inline--fa fa-play" aria-hidden="true" focusable="false" data-prefix="fas" data-icon="play" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor" d="M424.4 214.7L72.4 3.7C35.5-16.7 0 6.5 0 48v416c0 41.4 35.5 64.7 72.4 44.3l352-211c37.6-22.5 37.6-66.1 0-88.6z"></path></svg>`;
  } else {
    playAnimation();
    btn.classList.add('active');
    btn.innerHTML = `<svg class="svg-inline--fa fa-pause" aria-hidden="true" focusable="false" data-prefix="fas" data-icon="pause" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor" d="M144 480h-48c-26.51 0-48-21.49-48-48V80c0-26.51 21.49-48 48-48h48c26.51 0 48 21.49 48 48v352c0 26.51 21.49 48-48 48zm208-48V80c0-26.51-21.49-48-48-48h-48c-26.51 0-48 21.49-48 48v352c0 26.51 21.49 48 48 48h48c26.51 0 48-21.49 48-48z"></path></svg>`;
  }
}

// ---- Data load ----
fetch('')
  .then(r => r.json())
  .then(data => {
    frames = organizeDataByTimestamp(data);
    if (frameSlider) frameSlider.max = timestampList.length - 1;
    updateSkeletons(frames[timestampList[0]]);
    playAnimation();
  })
  .catch(err => console.error('Error fetching data:', err));

// ---- DOM ready ----
window.addEventListener('DOMContentLoaded', () => {
  frameSlider = document.getElementById('frameSlider');
  playButton = document.getElementById('playPauseButton');
  stopButton = document.getElementById('stopButton');
  timestampElement = document.getElementById('timestamp');

  playButton?.addEventListener('click', togglePlayPause);
  stopButton?.addEventListener('click', stopAnimation);

  frameSlider?.addEventListener('input', function () {
    currentFrame = parseInt(this.value, 10);
    updateSkeletons(frames[timestampList[currentFrame]]);
  });
});

// ---- Resize / Render loop ----
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

(function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
})();
