import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  BUDDY_SCALE,
  GROWTH,
  GROWTH_TARGETS,
  NO_BLINK,
  expressionOffset,
  growthForStep,
  hoverPoint,
  type Expression,
} from '../lib/buddy';
import { studioEnvironment } from '../lib/studioEnvironment';
import { woundTarget } from '../lib/woundStages';

const BUDDY_URL = `${import.meta.env.BASE_URL}models/buddy.glb`;

/** How quickly Buddy catches up with where it wants to be (1/s), and turns to face the viewer. */
const FOLLOW_RATE = 2.2;
const TURN_RATE = 4;
/** Before the hand is first seen, Buddy waits this far in front of the head (m). */
const WAIT_AHEAD = 0.55;
/** With the hand gone this long (s), Buddy dozes off until it's back. */
const SLEEP_AFTER = 6;
/** Blinks: this long (s), every 2.2–5.2 s. */
const BLINK_SECONDS = 0.12;
/** Cross-fade between clips (s), and the time the flower takes to grow a stage. */
const FADE = 0.3;
const GROW_SECONDS = 1;
/** Strength of the studio reflections on Buddy's body, leaves and petals. */
const ENV_INTENSITY = 0.35;
/** A reaction's face stays this long (s). */
const REACTION_SECONDS = 2.2;

type Clip = 'Idle_Float' | 'Wave' | 'Happy_Bounce' | 'Excited' | 'Sleepy' | 'Nod_Yes' | 'Shake_No';

interface BuddyRig {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<Clip, THREE.AnimationAction>;
  face: THREE.MeshStandardMaterial | null;
  sprouts: THREE.Mesh[];
}

function makeRig(gltf: GLTF): BuddyRig {
  const root = gltf.scene;
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<Clip, THREE.AnimationAction>();
  for (const clip of gltf.animations) actions.set(clip.name as Clip, mixer.clipAction(clip));
  let face: THREE.MeshStandardMaterial | null = null;
  const sprouts: THREE.Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (material.name === 'MAT_Buddy_Face') {
      // A decal just above the body: drawn after it, without writing depth, so it never flickers.
      face = material;
      material.depthWrite = false;
      mesh.renderOrder = 6;
    } else {
      mesh.renderOrder = 5;
    }
    if (mesh.morphTargetDictionary && GROWTH_TARGETS.every((name) => name in mesh.morphTargetDictionary!)) sprouts.push(mesh);
  });
  return { root, mixer, actions, face, sprouts };
}

/**
 * Buddy in the headset: floats beside the hand with the wound, turned to the
 * viewer, idling, blinking and waving hello when the hand first shows. It
 * reacts to the wound's build stages (a nod for each, a celebration when the
 * wound is finished again) and its flower grows with them: a tiny leaf at
 * stage 1 up to the full flower at stage 5. With the hand gone for a while it
 * dozes off, and wakes when it's back.
 */
export function XRBuddy({ active }: { active: boolean }) {
  const [rig, setRig] = useState<BuddyRig | null>(null);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    let cancelled = false;
    new GLTFLoader()
      .loadAsync(BUDDY_URL)
      .then((gltf) => {
        if (!cancelled) setRig(makeRig(gltf));
      })
      .catch((error) => console.error('Could not load Buddy', error));
    return () => {
      cancelled = true;
    };
  }, []);

  const holder = useMemo(() => {
    const group = new THREE.Group();
    group.visible = false;
    return group;
  }, []);
  // Soft studio reflections, as in Buddy's reference render (the room's light alone leaves it dull).
  // Made when the scene mounts, before the session (see studioEnvironment); Buddy may load later.
  const envMap = useRef<THREE.Texture | null>(null);
  useEffect(() => {
    envMap.current = studioEnvironment(gl);
  }, [gl]);
  useEffect(() => {
    if (!rig) return;
    rig.root.traverse((o) => {
      const material = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (!(o as THREE.Mesh).isMesh || !material || material === rig.face) return;
      material.envMap = envMap.current;
      material.envMapIntensity = ENV_INTENSITY;
      material.needsUpdate = true;
    });
  }, [rig]);

  useEffect(() => {
    if (!rig) return;
    rig.root.scale.setScalar(BUDDY_SCALE);
    holder.add(rig.root);
    rig.actions.get('Idle_Float')?.play();
    return () => {
      holder.remove(rig.root);
      rig.mixer.stopAllAction();
    };
  }, [rig, holder]);

  const state = useMemo(
    () => ({
      placed: false,
      everSeen: false,
      greeted: false,
      lostFor: 0,
      asleep: false,
      time: 0,
      step: -1,
      base: 'Idle_Float' as Clip,
      oneShot: null as THREE.AnimationAction | null,
      expression: 'happy' as Expression,
      reactionFor: 0,
      reactionFace: 'happy' as Expression,
      blinkIn: 3,
      blinkFor: 0,
      growth: GROWTH[GROWTH.length - 1].slice() as number[],
      growthTarget: GROWTH.length - 1,
      eye: new THREE.Vector3(),
      target: new THREE.Vector3(),
      look: new THREE.Vector3(),
      yaw: new THREE.Quaternion(),
      offset: new THREE.Vector2(),
    }),
    [],
  );

  useEffect(() => {
    if (!rig) return;
    const onFinished = (event: { action: THREE.AnimationAction }) => {
      if (event.action !== state.oneShot) return;
      state.oneShot = null;
      const base = rig.actions.get(state.base);
      if (base) {
        base.reset().play();
        event.action.crossFadeTo(base, FADE, false);
      }
    };
    rig.mixer.addEventListener('finished', onFinished);
    return () => rig.mixer.removeEventListener('finished', onFinished);
  }, [rig, state]);

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __buddy?: unknown }).__buddy = { rig, state, holder };
  }, [rig, state, holder]);

  // One frame of Buddy. If it ever fails, Buddy hides and stops: it must never stop the wound or the panels.
  const broken = useRef(false);
  useFrame((_, delta) => {
    if (broken.current) return;
    try {
      frame(delta);
    } catch (error) {
      broken.current = true;
      holder.visible = false;
      console.error('Buddy stopped', error);
    }
  });
  function frame(delta: number) {
    if (!rig) return;
    holder.visible = active;
    if (!active) return;
    const dt = Math.min(delta, 0.1);
    state.time += dt;

    const play = (name: Clip, repetitions = 1) => {
      const action = rig.actions.get(name);
      if (!action) return;
      const from = state.oneShot ?? rig.actions.get(state.base);
      action.reset();
      action.setLoop(repetitions > 1 ? THREE.LoopRepeat : THREE.LoopOnce, repetitions);
      action.clampWhenFinished = true;
      action.play();
      if (from && from !== action) from.crossFadeTo(action, FADE, false);
      state.oneShot = action;
    };
    const setBase = (name: Clip) => {
      if (state.base === name) return;
      const from = rig.actions.get(state.base);
      const to = rig.actions.get(name);
      state.base = name;
      if (!to || state.oneShot) return;
      to.reset().play();
      if (from) from.crossFadeTo(to, FADE * 2, false);
    };
    const react = (face: Expression, seconds = REACTION_SECONDS) => {
      state.reactionFace = face;
      state.reactionFor = seconds;
    };

    // The viewer's eyes.
    (gl.xr.isPresenting ? gl.xr.getCamera() : camera).getWorldPosition(state.eye);

    // Where to be.
    const seen = woundTarget.visible;
    if (seen) {
      state.lostFor = 0;
      hoverPoint(woundTarget.point, state.eye, woundTarget.hand, state.time, state.target);
      if (!state.everSeen) state.everSeen = true;
    } else {
      state.lostFor += dt;
      if (!state.everSeen && !state.placed) {
        // Wait in front of the viewer, a little low, until the hand shows.
        const head = gl.xr.isPresenting ? gl.xr.getCamera() : camera;
        state.target.set(0, 0, -1).applyQuaternion(head.getWorldQuaternion(state.yaw)).setY(0).normalize();
        state.target.multiplyScalar(WAIT_AHEAD).add(state.eye).setY(state.eye.y - 0.15);
      }
    }
    if (!state.placed) {
      holder.position.copy(state.target);
      state.placed = true;
    } else {
      holder.position.lerp(state.target, 1 - Math.exp(-FOLLOW_RATE * dt));
    }

    // Turned to face the viewer (yaw only, so it stays upright).
    state.look.set(state.eye.x, holder.position.y, state.eye.z);
    const dx = state.look.x - holder.position.x;
    const dz = state.look.z - holder.position.z;
    if (dx * dx + dz * dz > 1e-6) {
      state.yaw.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(dx, dz));
      holder.quaternion.slerp(state.yaw, 1 - Math.exp(-TURN_RATE * dt));
    }

    // Moods: a wave on meeting the hand, sleep without it.
    if (seen && !state.greeted && holder.position.distanceTo(state.target) < 0.08) {
      state.greeted = true;
      play('Wave');
      react('excited');
    }
    if (!seen && state.everSeen && state.lostFor > SLEEP_AFTER && !state.asleep) {
      state.asleep = true;
      setBase('Sleepy');
    }
    if (seen && state.asleep) {
      state.asleep = false;
      setBase('Idle_Float');
      play('Happy_Bounce');
      react('surprised', 1.2);
    }

    // The wound's build stages: a nod for each, a celebration back at the finished wound; the flower grows with them.
    if (state.step !== woundTarget.step) {
      const first = state.step < 0;
      const step = woundTarget.step;
      state.step = step;
      state.growthTarget = growthForStep(step);
      if (first) {
        state.growth = GROWTH[state.growthTarget].slice();
      } else if (step === 0) {
        play('Happy_Bounce', 2);
        react('love', 2.5);
      } else {
        play('Nod_Yes');
        react(step === 1 ? 'curious' : step === 5 ? 'excited' : 'thinking');
      }
    }
    const goal = GROWTH[state.growthTarget];
    const k = Math.min(dt / GROW_SECONDS, 1) * 3;
    for (let i = 0; i < 3; i++) state.growth[i] += THREE.MathUtils.clamp(goal[i] - state.growth[i], -k, k);
    for (const mesh of rig.sprouts) {
      GROWTH_TARGETS.forEach((name, i) => {
        mesh.morphTargetInfluences![mesh.morphTargetDictionary![name]] = state.growth[i];
      });
    }

    // Face: the mood or reaction, with a blink now and then.
    state.reactionFor -= dt;
    let face: Expression = state.asleep ? 'sleepy' : state.reactionFor > 0 ? state.reactionFace : 'happy';
    state.blinkIn -= dt;
    if (state.blinkIn <= 0 && !NO_BLINK.has(face)) {
      state.blinkFor = BLINK_SECONDS;
      state.blinkIn = 2.2 + Math.random() * 3;
    }
    if (state.blinkFor > 0) {
      state.blinkFor -= dt;
      if (!NO_BLINK.has(face)) face = 'blink';
    }
    if (rig.face?.map && face !== state.expression) {
      state.expression = face;
      rig.face.map.offset.copy(expressionOffset(face, state.offset));
    }

    rig.mixer.update(dt);
  }

  return <primitive object={holder} />;
}
