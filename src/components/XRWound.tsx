import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { XREstimatedLight } from 'three/examples/jsm/webxr/XREstimatedLight.js';
import { PinchDetector } from '../mat/lib/pinch';
import { normaliseWound, type WoundGeometryInfo } from '../lib/woundGeometry';
import { STAGE_COUNT, STAGE_URLS, isPinchAtWound, nextStep, stepLabel, woundTarget } from '../lib/woundStages';
import { XRHandModel, prepareHandModel } from '../lib/xrHandModel';
import { applyPalmSurface, buildPalmSurface } from '../lib/xrWoundConform';
import { SKIN_PRESETS, setAutoWorking, xrPrefs, type HandSide } from '../lib/xrPrefs';
import { XRSkinSampler } from '../lib/xrSkinSampler';
import { createXRWoundMaterial, skinToneColor } from '../lib/xrWoundMaterial';

const WOUND_URL = `${import.meta.env.BASE_URL}models/Wound.glb`;

/**
 * The wound's length (cm) on an average hand (REFERENCE_PALM_CM from wrist to
 * middle knuckle); it's scaled with the user's own palm…
 */
export const LENGTH_CM = 8.5;
export const REFERENCE_PALM_CM = 9.5;
/** …turned this far from the palm's long axis towards the thumb (degrees)… */
export const ANGLE_DEG = 35;
/** …this far above the skin (mm; the panel's Height slider adds ±5)… */
export const OFFSET_MM = 0.5;
/** …and moved on the palm (mm): [towards the thumb, towards the fingers], from the metacarpals' centre (their joints sit at the base of the palm). */
export const PALM_OFFSET_MM: readonly [number, number] = [0, 20];

/** How often the palm's colour is read from the camera, when allowed (s). */
const SKIN_SAMPLE_SECONDS = 0.5;

/** After the hand is lost the wound stays put this long (s)… */
const HOLD_SECONDS = 0.5;
/** …then fades out over this long (s). */
const FADE_SECONDS = 0.2;

const METACARPALS = [
  'index-finger-metacarpal',
  'middle-finger-metacarpal',
  'ring-finger-metacarpal',
  'pinky-finger-metacarpal',
] as const;

interface PalmFrame {
  /** Point on the palm's skin where the wound's centre goes (world). */
  point: THREE.Vector3;
  /** The wound's orientation: +Y out of the palm, +Z along its length. */
  quaternion: THREE.Quaternion;
}

/**
 * The palm, straight from the chosen hand's joints this frame:
 * origin at the four metacarpals' centre, normal = −Y of the middle
 * metacarpal (WebXR: out of the palm, on either hand), long axis from the
 * middle metacarpal to the middle knuckle, skin = origin + normal × the
 * metacarpals' mean radius.
 */
class PalmFrameReader {
  readonly origin = new THREE.Vector3();
  /** Along the palm (towards the fingers) and across it (towards the thumb), unit. */
  readonly along = new THREE.Vector3();
  readonly across = new THREE.Vector3();
  /** Out of the palm (unit). */
  readonly normal = new THREE.Vector3();
  /** On the skin above the metacarpals' centre. */
  readonly skin = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly x = new THREE.Vector3();
  private readonly basis = new THREE.Matrix4();
  radius = 0.01;

  read(hand: THREE.XRHandSpace, out: PalmFrame): boolean {
    const j = hand.joints;
    const middle = j['middle-finger-metacarpal'];
    const knuckle = j['middle-finger-phalanx-proximal'];
    const thumb = j['thumb-metacarpal'];
    if (!middle?.visible || !knuckle || !thumb) return false;
    this.origin.set(0, 0, 0);
    let radius = 0;
    for (const name of METACARPALS) {
      const joint = j[name];
      if (!joint) return false;
      this.origin.add(joint.position);
      radius += joint.jointRadius ?? 0.01;
    }
    this.origin.multiplyScalar(1 / METACARPALS.length);
    this.radius = radius / METACARPALS.length;

    this.normal.set(0, -1, 0).applyQuaternion(middle.quaternion);
    this.along.subVectors(knuckle.position, middle.position);
    this.along.addScaledVector(this.normal, -this.along.dot(this.normal)).normalize();
    // Across the palm, signed so + points to the thumb side (either hand).
    this.across.crossVectors(this.normal, this.along);
    if (this.dir.subVectors(thumb.position, this.origin).dot(this.across) < 0) this.across.negate();

    this.skin.copy(this.origin).addScaledVector(this.normal, this.radius);
    out.point
      .copy(this.origin)
      .addScaledVector(this.normal, this.radius + OFFSET_MM / 1000)
      .addScaledVector(this.across, PALM_OFFSET_MM[0] / 1000)
      .addScaledVector(this.along, PALM_OFFSET_MM[1] / 1000);
    // Length runs ANGLE_DEG from the long axis towards the thumb.
    const a = THREE.MathUtils.degToRad(ANGLE_DEG);
    this.dir.copy(this.along).multiplyScalar(Math.cos(a)).addScaledVector(this.across, Math.sin(a));
    this.x.crossVectors(this.normal, this.dir);
    this.basis.makeBasis(this.x, this.normal, this.dir);
    out.quaternion.setFromRotationMatrix(this.basis);
    return true;
  }
}

/** Tracks which hand space is which hand (they connect in any order). */
function useHandSpaces() {
  const gl = useThree((s) => s.gl);
  // Slot per hand space: its handedness while connected (no per-frame allocation to look up).
  const slots = useMemo(() => [null, null] as (XRHandedness | null)[], []);
  useEffect(() => {
    const offs = [0, 1].map((i) => {
      const hand = gl.xr.getHand(i);
      const onConnected = (event: { data: XRInputSource }) => {
        if (event.data.hand) slots[i] = event.data.handedness;
      };
      const onDisconnected = () => (slots[i] = null);
      hand.addEventListener('connected', onConnected);
      hand.addEventListener('disconnected', onDisconnected);
      return () => {
        hand.removeEventListener('connected', onConnected);
        hand.removeEventListener('disconnected', onDisconnected);
      };
    });
    return () => offs.forEach((off) => off());
  }, [gl, slots]);
  return (side: HandSide): THREE.XRHandSpace | null => {
    for (let i = 0; i < 2; i++) if (slots[i] === side) return gl.xr.getHand(i);
    return null;
  };
}

interface XRWoundProps {
  /** Wound opacity 0..1 (the shared slider). */
  strength: RefObject<number>;
}

/** Fix the wound to the hand model's skin (it then deforms with the hand); false: rigid on the palm frame. */
export const USE_SKINNING = true;

const HAND_URL = `${import.meta.env.BASE_URL}models/Hand.glb`;

const FINGERTIPS = [
  ['index-finger-phalanx-proximal', 'index-finger-tip'],
  ['middle-finger-phalanx-proximal', 'middle-finger-tip'],
  ['ring-finger-phalanx-proximal', 'ring-finger-tip'],
  ['pinky-finger-phalanx-proximal', 'pinky-finger-tip'],
] as const;
/** A hand counts as open when its fingertips are this far from the wrist, relative to its knuckles (flat ≈ 2, fist ≈ 1). */
const OPEN_RATIO = 1.6;

/** Whether the hand is open enough to lay the wound on its palm. */
function isHandOpen(hand: THREE.XRHandSpace): boolean {
  const wrist = hand.joints.wrist;
  if (!wrist) return false;
  let sum = 0;
  for (const [knuckleName, tipName] of FINGERTIPS) {
    const knuckle = hand.joints[knuckleName];
    const tip = hand.joints[tipName];
    if (!knuckle || !tip) return false;
    sum += wrist.position.distanceTo(tip.position) / Math.max(wrist.position.distanceTo(knuckle.position), 1e-6);
  }
  return sum / FINGERTIPS.length > OPEN_RATIO;
}

/** Adds (empty) skin index/weight attributes, filled at each bind, and keeps the shape as loaded to lay it onto the hand afresh at each bind. */
function prepareForSkinning(geometry: THREE.BufferGeometry) {
  const n = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
  geometry.userData.restPositions = (geometry.getAttribute('position').array as Float32Array).slice();
  geometry.userData.restNormals = (geometry.getAttribute('normal').array as Float32Array).slice();
}

/** The skin colour baked into Stage_5's texture around the wound (sRGB), mapped to the user's skin tone. */
const STAGE_BAKED_SKIN = new THREE.Color().setRGB(227 / 255, 175 / 255, 148 / 255, THREE.SRGBColorSpace);
const STAGE_BAKED_SKIN_INVERSE = new THREE.Color(1 / STAGE_BAKED_SKIN.r, 1 / STAGE_BAKED_SKIN.g, 1 / STAGE_BAKED_SKIN.b);

interface Stage {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  /** Painted (its baked skin is mapped to the skin tone) rather than plain clay. */
  textured: boolean;
}

/**
 * A stage model, moved into the wound's frame the same way Wound.glb was
 * (they were modelled in the same place), so it sits exactly where the wound does.
 */
function loadStage(gltf: { scene: THREE.Object3D }, wound: WoundGeometryInfo): Stage | null {
  gltf.scene.updateMatrixWorld(true);
  let source: THREE.Mesh | null = null;
  gltf.scene.traverse((o) => {
    if (!source && (o as THREE.Mesh).isMesh) source = o as THREE.Mesh;
  });
  if (!source) return null;
  const mesh = source as THREE.Mesh;
  const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  geometry.translate(-wound.origin.x, -wound.origin.y, -wound.origin.z);
  geometry.scale(wound.scale, wound.scale, wound.scale);
  // Its normals are bent onto the palm at each bind; the normal map then works from screen-space derivatives.
  geometry.deleteAttribute('tangent');
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  prepareForSkinning(geometry);
  mesh.geometry.dispose();
  const loaded = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
  const textured = !!loaded.map;
  const material = textured
    ? loaded
    : new THREE.MeshStandardMaterial({ color: loaded.color, roughness: loaded.roughness ?? 0.9, metalness: 0, side: THREE.DoubleSide });
  if (!textured) loaded.dispose();
  Object.assign(material, {
    transparent: true,
    toneMapped: false,
    envMapIntensity: 0.4,
    // Always wins over the palm slab just below it, as the wound does.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  return { geometry, material, textured };
}

/** Pinches are ignored this long after the wound appears (s), so one already under way doesn't skip the finished wound. */
const PINCH_SETTLE_SECONDS = 2;

/** How long a step's label stays up (s), and the first hint about the stages. */
const LABEL_SECONDS = 3;
const FIRST_HINT_SECONDS = 5;
const LABEL_W = 0.12;
const LABEL_H = 0.035;

/** A small label above the wound naming the step shown (in the style of the headset's hint). */
class StepLabel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private showFor = 0;

  constructor() {
    this.canvas.width = 960;
    this.canvas.height = 280;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(LABEL_W, LABEL_H),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
  }

  show(step: number, seconds = LABEL_SECONDS) {
    const { title, detail } = stepLabel(step);
    const ctx = this.canvas.getContext('2d')!;
    const { width: w, height: h } = this.canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(251, 250, 247, 0.94)';
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 8, 70);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#1f2a24';
    ctx.font = '600 84px "DM Sans", system-ui, sans-serif';
    ctx.fillText(title, w / 2, 128);
    ctx.fillStyle = '#5d6762';
    ctx.font = '500 50px "DM Sans", system-ui, sans-serif';
    ctx.fillText(detail, w / 2, 210);
    this.texture.needsUpdate = true;
    this.showFor = seconds;
  }

  /** Above the wound as the viewer sees it (along the head's up, so it never covers it), turned to face them. */
  update(delta: number, at: THREE.Vector3, eye: THREE.Vector3, up: THREE.Vector3, opacity: number) {
    this.showFor -= delta;
    const fade = THREE.MathUtils.clamp(this.showFor / 0.3, 0, 1) * opacity;
    this.mesh.visible = fade > 0;
    if (!this.mesh.visible) return;
    this.mesh.material.opacity = fade;
    this.mesh.position.copy(at).addScaledVector(up, 0.075);
    this.mesh.up.copy(up);
    this.mesh.lookAt(eye);
  }

  dispose() {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/**
 * The wound in the headset: on the chosen hand only. A detailed hand model is
 * posed on that hand's joints every frame (no smoothing: the runtime already
 * predicts poses); the wound is laid onto the model's palm skin and skinned
 * with the model's own weights, so it stays on that skin as the hand moves and
 * bends. The model, drawn depth-only, hides the wound behind the real hand.
 * When the hand is lost the wound stays put for 0.5 s, then fades, and
 * reappears at once at the new pose.
 */
export function XRWound({ strength }: XRWoundProps) {
  const findHand = useHandSpaces();
  const [info, setInfo] = useState<WoundGeometryInfo | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);
  const [handSource, setHandSource] = useState<THREE.SkinnedMesh | null>(null);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const material = useMemo(() => createXRWoundMaterial(), []);

  useEffect(() => {
    let cancelled = false;
    let loaded: WoundGeometryInfo | null = null;
    let loadedStages: Stage[] = [];
    const loader = new GLTFLoader();
    // The wound never waits for the stages: they're added (and laid onto the hand) when they arrive.
    const stagesLoading = Promise.all(STAGE_URLS.map((url) => loader.loadAsync(url)));
    loader
      .loadAsync(WOUND_URL)
      .then((gltf) => {
        let geometry: THREE.BufferGeometry | null = null;
        gltf.scene.traverse((o) => {
          if (!geometry && (o as THREE.Mesh).isMesh) geometry = (o as THREE.Mesh).geometry;
        });
        if (!geometry || cancelled) return;
        loaded = normaliseWound(geometry, LENGTH_CM / 100);
        (geometry as THREE.BufferGeometry).dispose();
        prepareForSkinning(loaded.geometry);
        const info = loaded;
        setInfo(info);
        stagesLoading
          .then((stageGltfs) => {
            if (cancelled) return;
            const made = stageGltfs.map((g) => loadStage(g, info)).filter((stage): stage is Stage => !!stage);
            if (made.length !== STAGE_COUNT) return;
            loadedStages = made;
            setStages(made);
          })
          .catch((error) => console.error('Could not load the wound stages', error));
      })
      .catch((error) => console.error('Could not load the wound model', error));
    new GLTFLoader()
      .loadAsync(HAND_URL)
      .then((gltf) => {
        let mesh: THREE.SkinnedMesh | null = null;
        gltf.scene.traverse((o) => {
          if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
        });
        if (!cancelled) setHandSource(mesh);
      })
      .catch((error) => console.error('Could not load the hand model', error));
    return () => {
      cancelled = true;
      loaded?.geometry.dispose();
      for (const stage of loadedStages) {
        stage.geometry.dispose();
        stage.material.map?.dispose();
        stage.material.normalMap?.dispose();
        stage.material.roughnessMap?.dispose();
        stage.material.aoMap?.dispose();
        stage.material.dispose();
      }
    };
  }, []);
  useEffect(() => () => material.dispose(), [material]);

  // The hand model, as a left and a right hand.
  const hands = useMemo(() => {
    if (!handSource) return null;
    return { left: new XRHandModel(prepareHandModel(handSource, false)), right: new XRHandModel(prepareHandModel(handSource, true)) };
  }, [handSource]);
  useEffect(
    () => () => {
      hands?.left.dispose();
      hands?.right.dispose();
    },
    [hands],
  );

  // Soft studio reflections for the wet blood (or the room's own, if the
  // session estimates the real light).
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const envMap = pmrem.fromScene(room, 0.04).texture;
    const setEnv = (map: THREE.Texture | null) => {
      for (const m of [material, ...stages.map((stage) => stage.material)]) {
        m.envMap = map;
        m.needsUpdate = true;
      }
    };
    setEnv(envMap);
    room.dispose();
    pmrem.dispose();

    const estimated = new XREstimatedLight(gl);
    const ownLights: THREE.Light[] = [];
    const onStart = () => {
      // The real room's light replaces the scene's fixed lights.
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight && o.visible) ownLights.push(o as THREE.Light);
      });
      ownLights.forEach((light) => (light.visible = false));
      scene.add(estimated);
      if (estimated.environment) setEnv(estimated.environment);
    };
    const onEnd = () => {
      scene.remove(estimated);
      ownLights.forEach((light) => (light.visible = true));
      ownLights.length = 0;
      setEnv(envMap);
    };
    estimated.addEventListener('estimationstart', onStart);
    estimated.addEventListener('estimationend', onEnd);
    return () => {
      estimated.removeEventListener('estimationstart', onStart);
      estimated.removeEventListener('estimationend', onEnd);
      onEnd();
      estimated.dispose();
      envMap.dispose();
    };
  }, [gl, scene, material, stages]);

  // The wound, parented to the scene (never to the hand).
  const mesh = useMemo(() => {
    if (!info) return null;
    const o = USE_SKINNING ? new THREE.SkinnedMesh(info.geometry, material) : new THREE.Mesh(info.geometry, material);
    o.frustumCulled = false;
    o.renderOrder = 3;
    o.visible = false;
    return o;
  }, [info, material]);

  // The stages, made the same way; only the current step's mesh is shown.
  const stageMeshes = useMemo(
    () =>
      stages.map((stage) => {
        const o = USE_SKINNING ? new THREE.SkinnedMesh(stage.geometry, stage.material) : new THREE.Mesh(stage.geometry, stage.material);
        o.frustumCulled = false;
        o.renderOrder = 3;
        o.visible = false;
        return o;
      }),
    [stages],
  );
  const label = useMemo(() => new StepLabel(), []);
  useEffect(
    () => () => {
      label.dispose();
      woundTarget.visible = false;
    },
    [label],
  );

  const state = useMemo(
    () => ({
      reader: new PalmFrameReader(),
      frame: { point: new THREE.Vector3(), quaternion: new THREE.Quaternion() } as PalmFrame,
      placed: false,
      bound: false,
      pendingBind: false,
      /** How many stage meshes the last bind laid onto the hand (they may arrive after the wound). */
      boundStages: 0,
      boundHeight: 0,
      sinceBind: 0,
      lostFor: Infinity,
      boundHand: null as HandSide | null,
      boundReattach: -1,
      skinVersion: -1,
      toWound: new THREE.Matrix4(),
      surface: null as Float32Array | null,
      sampler: new XRSkinSampler(),
      sampleIn: 0,
      samplePoints: [0, 1, 2, 3, 4].map(() => new THREE.Vector3()),
      /** 0: the finished wound; 1…STAGE_COUNT: that stage. */
      step: 0,
      pinch: new PinchDetector(),
      pinchPoint: new THREE.Vector3(),
      hinted: false,
      /** How long the wound has been on show (s). */
      shownFor: 0,
      eye: new THREE.Vector3(),
      headUp: new THREE.Vector3(),
      headQuaternion: new THREE.Quaternion(),
    }),
    [],
  );

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __xrWound?: unknown }).__xrWound = { state, mesh, stageMeshes, label, hands, findHand, prefs: xrPrefs, scene };
  }, [state, mesh, stageMeshes, label, hands, findHand, scene]);

  useFrame((_, delta) => {
    if (!mesh || !hands) return;
    if (state.skinVersion !== xrPrefs.version) {
      state.skinVersion = xrPrefs.version;
      if (!(xrPrefs.skinAuto && xrPrefs.autoWorking)) {
        skinToneColor(SKIN_PRESETS[xrPrefs.skinPreset], xrPrefs.skinFine, material.userData.uniforms.skinTone.value);
      }
    }
    // The painted stage's skin takes the same skin tone (the clay keeps its own colour, so it shows).
    const skinTone = material.userData.uniforms.skinTone.value;
    for (const stage of stages) {
      if (stage.textured) stage.material.color.copy(skinTone).multiply(STAGE_BAKED_SKIN_INVERSE);
    }
    const model = xrPrefs.hand === 'left' ? hands.left : hands.right;
    const other = model === hands.left ? hands.right : hands.left;
    other.root.visible = false;
    const hand = findHand(xrPrefs.hand);
    // Joints are all-or-nothing: the wrist stands for the whole hand.
    const tracked = !!hand?.joints.wrist?.visible && state.reader.read(hand, state.frame) && model.update(hand);
    if (tracked) {
      if (USE_SKINNING) {
        // Measure the hand (~0.5 s) and then lay the wound on its palm: on the
        // first frame, on Calibrate, and when the hand changes.
        if (state.boundHand !== xrPrefs.hand || state.boundReattach !== xrPrefs.reattach) {
          state.boundHand = xrPrefs.hand;
          state.boundReattach = xrPrefs.reattach;
          model.startCalibration();
          state.pendingBind = true;
        }
        if (state.bound && state.boundStages !== stageMeshes.length) {
          state.boundStages = stageMeshes.length;
          state.pendingBind = true;
        }
        state.sinceBind += delta;
        // Only onto an open palm: with the fingers curled over it, the wound would land on them.
        const open = isHandOpen(hand);
        const heightChanged = state.bound && state.boundHeight !== xrPrefs.skinHeightMm && state.sinceBind > 0.15;
        if (open && ((state.pendingBind && model.calibrated) || heightChanged)) {
          const bound = bind(mesh as unknown as THREE.SkinnedMesh, model);
          state.bound = bound || state.bound;
          state.pendingBind = !bound && state.pendingBind;
          state.boundHeight = xrPrefs.skinHeightMm;
          state.sinceBind = 0;
          model.setOccluderPushExtra(-xrPrefs.skinHeightMm / 1000);
        }
      } else {
        mesh.position.copy(state.frame.point);
        mesh.quaternion.copy(state.frame.quaternion);
      }
      state.placed = state.bound || !USE_SKINNING;
      state.lostFor = 0;
      // Auto skin tone: the real palm's colour from the camera, if the session allows it.
      state.sampleIn -= delta;
      if (xrPrefs.skinAuto && state.sampleIn <= 0) {
        state.sampleIn = SKIN_SAMPLE_SECONDS;
        const r = state.reader;
        const pts = state.samplePoints;
        pts[0].copy(r.skin);
        pts[1].copy(r.skin).addScaledVector(r.along, 0.015);
        pts[2].copy(r.skin).addScaledVector(r.along, -0.015);
        pts[3].copy(r.skin).addScaledVector(r.across, 0.015);
        pts[4].copy(r.skin).addScaledVector(r.across, -0.015);
        if (state.sampler.sample(gl, pts)) {
          const c = state.sampler.srgb;
          material.userData.uniforms.skinTone.value.setRGB(c.x, c.y, c.z, THREE.SRGBColorSpace);
          setAutoWorking(true);
        } else if (!state.sampler.available) {
          setAutoWorking(false);
        }
      }
    } else {
      state.lostFor += delta;
    }
    const fade = state.lostFor <= HOLD_SECONDS ? 1 : 1 - (state.lostFor - HOLD_SECONDS) / FADE_SECONDS;
    const opacity = state.placed ? THREE.MathUtils.clamp(fade, 0, 1) * THREE.MathUtils.clamp(strength.current ?? 1, 0, 1) : 0;
    // Step through the stages: a pinch by the other hand, at the wound.
    const otherHand = findHand(xrPrefs.hand === 'left' ? 'right' : 'left');
    const thumb = otherHand?.joints['thumb-tip'];
    const index = otherHand?.joints['index-finger-tip'];
    const wrist = otherHand?.joints.wrist;
    const otherTracked = !!(wrist?.visible && thumb && index);
    const pinchEvent = state.pinch.update(otherTracked ? thumb!.position.distanceTo(index!.position) : null, delta);
    state.shownFor = opacity > 0 ? state.shownFor + delta : 0;
    if (pinchEvent === 'start' && otherTracked && stageMeshes.length > 0 && state.shownFor > PINCH_SETTLE_SECONDS) {
      state.pinchPoint.addVectors(thumb!.position, index!.position).multiplyScalar(0.5);
      if (isPinchAtWound(state.pinchPoint)) {
        state.step = nextStep(state.step);
        label.show(state.step);
      }
    }
    woundTarget.visible = opacity > 0;
    woundTarget.hand = xrPrefs.hand;
    woundTarget.point.copy(state.frame.point);

    material.opacity = opacity;
    mesh.visible = opacity > 0 && (state.step === 0 || stageMeshes.length === 0);
    stageMeshes.forEach((o, i) => {
      o.visible = opacity > 0 && state.step === i + 1;
      (o.material as THREE.MeshStandardMaterial).opacity = opacity;
    });
    const shown = opacity > 0;
    if (shown && !state.hinted && stageMeshes.length > 0) {
      state.hinted = true;
      label.show(state.step, FIRST_HINT_SECONDS);
    }
    const head = gl.xr.getCamera();
    head.getWorldPosition(state.eye);
    head.getWorldQuaternion(state.headQuaternion);
    state.headUp.set(0, 1, 0).applyQuaternion(state.headQuaternion);
    label.update(delta, state.frame.point, state.eye, state.headUp, shown ? 1 : 0);
    // The hand model: hides the wound behind the real hand; its wireframe on request.
    model.root.visible = shown || (xrPrefs.showHandMesh && tracked);
    model.occluder.visible = shown;
    model.wire.visible = xrPrefs.showHandMesh;
  });

  /** Lays the wound and its stages onto the hand model's palm skin as it is this frame and binds them to the model's bones. */
  function bind(skinned: THREE.SkinnedMesh, model: XRHandModel): boolean {
    // In proportion to this hand: bigger on a bigger palm, smaller on a smaller one.
    const handScale = model.palmLength / (REFERENCE_PALM_CM / 100);
    skinned.position.copy(state.frame.point);
    skinned.quaternion.copy(state.frame.quaternion);
    skinned.scale.setScalar(handScale);
    skinned.updateMatrixWorld(true);
    const handGeometry = model.data.geometry;
    const count = handGeometry.getAttribute('position').count;
    if (!state.surface || state.surface.length !== count * 3) state.surface = new Float32Array(count * 3);
    model.skinnedPositions(state.surface);
    state.toWound.copy(skinned.matrixWorld).invert();
    const surface = buildPalmSurface(
      info!.halfWidth,
      info!.halfLength,
      {
        positions: state.surface,
        index: handGeometry.getIndex()!.array as ArrayLike<number>,
        skinIndex: handGeometry.getAttribute('skinIndex') as THREE.BufferAttribute,
        skinWeight: handGeometry.getAttribute('skinWeight') as THREE.BufferAttribute,
      },
      state.toWound,
    );
    if (!surface) return false;
    const lift = (OFFSET_MM + xrPrefs.skinHeightMm) / 1000 / handScale;
    // A new skeleton on the model's bones, so its inverses capture this exact pose.
    const old = skinned.skeleton;
    const skeleton = new THREE.Skeleton(model.bones);
    for (const o of [skinned, ...(stageMeshes as unknown as THREE.SkinnedMesh[])]) {
      if (o !== skinned) {
        o.position.copy(skinned.position);
        o.quaternion.copy(skinned.quaternion);
        o.scale.copy(skinned.scale);
        o.updateMatrixWorld(true);
      }
      const g = o.geometry;
      applyPalmSurface(surface, { restPositions: g.userData.restPositions, restNormals: g.userData.restNormals }, lift, g);
      o.bind(skeleton, o.matrixWorld);
    }
    state.boundStages = stageMeshes.length;
    old?.dispose();
    return true;
  }

  return (
    <>
      {hands && <primitive object={hands.left.root} />}
      {hands && <primitive object={hands.right.root} />}
      {mesh && <primitive object={mesh} />}
      {stageMeshes.map((o, i) => (
        <primitive key={i} object={o} />
      ))}
      <primitive object={label.mesh} />
    </>
  );
}
