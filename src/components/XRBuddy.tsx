import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  BUDDY_COLOR,
  BUDDY_SCALE,
  BUDDY_SIZE_CM,
  GROWTH,
  GROWTH_TARGETS,
  NO_BLINK,
  STILL_SECONDS,
  STILL_SPEED,
  UNLOCK_MOVE,
  WORK_SIDE,
  buddyTarget,
  expressionOffset,
  growthForStage,
  springStep,
  type Expression,
} from '../lib/buddy';
import { BuddyMotion, type MotionInput } from '../lib/buddyMotion';
import { STAGE_COUNT, STAGE_LABELS, woundLink } from '../lib/woundSteps';
import { SpeechBubble } from '../lib/xrSpeechBubble';

const BUDDY_URL = `${import.meta.env.BASE_URL}models/buddy_character.glb`;

/** What Buddy says on its own occasions (the stage instructions are STAGE_LABELS). */
export const BUDDY_LINES = {
  hello: 'Hi! I’m Buddy. Pinch near the wound with your other hand to see how it’s made.',
  closer: 'Pinch a little closer to the wound.',
  done: 'You did it! That’s the full wound.',
};

/** Idle_Float's weight: the only animation that always plays, kept gentle. */
const IDLE_WEIGHT = 0.6;
/** While flying, Idle_Float gives way to Excited (arm flapping), up to this weight at top speed. */
const FLAP_WEIGHT = 0.7;
/** Frame time is clamped to this (s), so motion stays frame-rate independent without leaps. */
const MAX_DT = 0.05;
/** Cross-fades between clips (s). */
const FADE = 0.3;
/** With the wound hand lost this long (s), Buddy dozes off. */
const SLEEP_AFTER = 8;
/** The hand counts as lost (Buddy waits in front of the eyes) after this long without it (s). */
const LOST_AFTER = 0.5;
/** Blinks: this long (s), every 2.2–5.2 s; talking flips the mouth every TALK_FLIP s. */
const BLINK_SECONDS = 0.12;
const TALK_FLIP = 0.14;
/** The flower grows a stage over this long (s). */
const GROW_SECONDS = 1;
/** A passing line ("closer") stays this long after typing (s), then the current instruction returns. */
const PASSING_SECONDS = 3.5;
/** The bubble's gap beside Buddy (m), and how far Buddy must cross the wound before it changes side (m). */
const BUBBLE_GAP = 0.012;
const SIDE_SWITCH = 0.02;
const ENV_INTENSITY = 0.35;

type Clip = 'Idle_Float' | 'Wave' | 'Happy_Bounce' | 'Excited' | 'Sleepy' | 'Nod_Yes' | 'Shake_No';

interface BuddyRig {
  root: THREE.Object3D;
  /** The "Buddy" node: squash and stretch go here (the clips move bones only). */
  body: THREE.Object3D;
  bodyScale: THREE.Vector3;
  /** Excited, looping, for flapping while flying (its own action: the Excited occasion uses the other). */
  flap: THREE.AnimationAction | null;
  mixer: THREE.AnimationMixer;
  actions: Map<Clip, THREE.AnimationAction>;
  face: THREE.MeshStandardMaterial | null;
  sprouts: THREE.Mesh[];
  materials: THREE.MeshStandardMaterial[];
}

function makeRig(gltf: GLTF): BuddyRig {
  const root = gltf.scene;
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<Clip, THREE.AnimationAction>();
  for (const clip of gltf.animations) actions.set(clip.name as Clip, mixer.clipAction(clip));
  let face: THREE.MeshStandardMaterial | null = null;
  const sprouts: THREE.Mesh[] = [];
  const materials: THREE.MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false;
    const material = mesh.material as THREE.MeshStandardMaterial;
    if (material.name === 'MAT_Buddy_Face') {
      // A decal just above the body: drawn after it, without writing depth. Its own copy of the atlas, to move per expression.
      face = material;
      material.depthWrite = false;
      if (material.map) {
        material.map = material.map.clone();
        material.map.needsUpdate = true;
      }
      mesh.renderOrder = 6;
    } else {
      mesh.renderOrder = 5;
      if (!materials.includes(material)) materials.push(material);
      if (material.name === 'MAT_Buddy_Body') material.color.set(BUDDY_COLOR);
    }
    if (mesh.morphTargetDictionary && GROWTH_TARGETS.every((name) => name in mesh.morphTargetDictionary!)) sprouts.push(mesh);
  });
  const body = root.getObjectByName('Buddy') ?? root;
  const excited = gltf.animations.find((clip) => clip.name === 'Excited');
  const flap = excited ? mixer.clipAction(excited.clone()) : null;
  if (flap) {
    flap.setLoop(THREE.LoopRepeat, Infinity);
    flap.weight = 0;
    flap.play();
  }
  return { root, body, bodyScale: body.scale.clone(), flap, mixer, actions, face, sprouts, materials };
}

/**
 * Buddy in the headset: lives beside the wound hand (never in front of the
 * wound, always in view), getting about like a little creature (BuddyMotion:
 * it stays put for small moves, then decides and flies over), and speaks the
 * step flow's instructions in a speech bubble. Idle_Float, gently, is its only constant
 * motion; every other clip plays on an occasion (hello, the flow starting,
 * each stage, a near miss, the flow done, dozing off). Its flower grows with
 * the stages. Reads the wound through `woundLink`; never stops the wound:
 * any error hides Buddy instead.
 */
export function XRBuddy({ active }: { active: boolean }) {
  const [rig, setRig] = useState<BuddyRig | null>(null);
  const gl = useThree((s) => s.gl);

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
  const bubble = useMemo(() => new SpeechBubble(STAGE_COUNT), []);
  useEffect(() => () => bubble.dispose(), [bubble]);

  // Soft studio reflections (the room's light alone leaves Buddy dull), made once when the scene mounts, before any session.
  const envMap = useRef<THREE.Texture | null>(null);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const texture = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    envMap.current = texture;
    return () => texture.dispose();
  }, [gl]);

  useEffect(() => {
    if (!rig) return;
    for (const material of rig.materials) {
      material.envMap = envMap.current;
      material.envMapIntensity = ENV_INTENSITY;
      material.needsUpdate = true;
    }
    rig.root.scale.setScalar(BUDDY_SCALE);
    holder.add(rig.root);
    const idle = rig.actions.get('Idle_Float');
    if (idle) {
      idle.weight = IDLE_WEIGHT;
      idle.play();
    }
    return () => {
      holder.remove(rig.root);
      rig.mixer.stopAllAction();
    };
  }, [rig, holder]);

  const state = useMemo(
    () => ({
      broken: false,
      placed: false,
      greeted: false,
      started: false,
      asleep: false,
      lostFor: Infinity,
      steps: 0,
      misses: 0,
      // Clips: the base loop, the one-shot playing and at most one waiting.
      base: 'Idle_Float' as Clip,
      current: null as THREE.AnimationAction | null,
      queued: null as Clip | null,
      queuedRepeats: 1,
      // Face.
      expression: '' as Expression | '',
      eventFace: 'happy' as Expression,
      eventFor: 0,
      typingFace: null as Expression | null,
      talkClock: 0,
      blinkIn: 3,
      blinkFor: 0,
      // Speech: the standing line (with its dots) and a passing one's timer.
      line: '',
      lineDots: null as number | null,
      passingFor: 0,
      // Speech waiting for Buddy to arrive.
      pending: false,
      pendingLine: '',
      pendingDots: null as number | null,
      pendingFace: null as Expression | null,
      pendingPassing: false,
      // Moves the next landing finishes: a wave (hello), a bounce (flow done).
      waveOnLanding: false,
      bounceOnLanding: false,
      // Growth.
      growth: [1, 1, 1],
      // Working: the hand still during a step, Buddy parked to its left.
      handPrev: new THREE.Vector3(),
      handSeen: false,
      handSpeed: 0,
      stillFor: 0,
      locked: false,
      lockHand: new THREE.Vector3(),
      lockPoint: new THREE.Vector3(),
      left: new THREE.Vector3(),
      // Motion.
      motion: new BuddyMotion(),
      entered: false,
      home: new THREE.Vector3(),
      input: {
        eye: new THREE.Vector3(),
        gaze: new THREE.Vector3(),
        right: new THREE.Vector3(),
        up: new THREE.Vector3(),
        home: new THREE.Vector3(),
        wound: null,
        watchWound: false,
        facingViewer: false,
        expressive: false,
        idle: false,
      } as MotionInput,
      headTurn: new THREE.Quaternion(),
      scratch: new THREE.Vector3(),
      bubbleSide: 1 as 1 | -1,
      bubbleAt: new THREE.Vector3(),
      bubbleGoal: new THREE.Vector3(),
      bubbleVel: new THREE.Vector3(),
      bubblePlaced: false,
      offset: new THREE.Vector2(),
    }),
    [],
  );

  // A one-shot finished: back to the base loop, then the queued one if any.
  useEffect(() => {
    if (!rig) return;
    const onFinished = (event: { action: THREE.AnimationAction }) => {
      if (event.action !== state.current) return;
      state.current.fadeOut(FADE);
      state.current = null;
      fadeInBase(rig);
      if (state.queued) {
        const next = state.queued;
        state.queued = null;
        startClip(rig, next, state.queuedRepeats);
      }
    };
    rig.mixer.addEventListener('finished', onFinished);
    return () => rig.mixer.removeEventListener('finished', onFinished);
  }, [rig, state]);

  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __buddy?: unknown }).__buddy = { rig, state, holder, bubble };
  }, [rig, state, holder, bubble]);

  function fadeInBase(r: BuddyRig) {
    const base = r.actions.get(state.base);
    if (!base) return;
    base.reset();
    base.weight = state.base === 'Idle_Float' ? IDLE_WEIGHT : 1;
    base.fadeIn(FADE).play();
  }

  function startClip(r: BuddyRig, name: Clip, repeats: number) {
    const action = r.actions.get(name);
    if (!action) return;
    action.reset();
    action.setLoop(repeats > 1 ? THREE.LoopRepeat : THREE.LoopOnce, repeats);
    action.clampWhenFinished = true;
    action.weight = 1;
    action.fadeIn(FADE).play();
    r.actions.get(state.base)?.fadeOut(FADE);
    state.current = action;
  }

  /** Plays a one-shot now, or after the one playing (only the newest waits). */
  function play(r: BuddyRig, name: Clip, repeats = 1) {
    if (state.current) {
      state.queued = name;
      state.queuedRepeats = repeats;
      return;
    }
    startClip(r, name, repeats);
  }

  function setBase(r: BuddyRig, name: Clip) {
    if (state.base === name) return;
    const old = r.actions.get(state.base);
    state.base = name;
    if (state.current) return; // the one-shot hands over to the new base when it ends
    old?.fadeOut(FADE);
    fadeInBase(r);
  }

  function react(face: Expression, seconds: number) {
    state.eventFace = face;
    state.eventFor = seconds;
  }

  /** The standing line (typed out), shown until the next one; typing waits until Buddy has arrived. */
  function say(line: string, dots: number | null, typingFace: Expression | null) {
    state.line = line;
    state.lineDots = dots;
    queueSpeech(line, dots, typingFace, false);
  }

  /** A passing line: typed out, then the standing line returns. */
  function sayPassing(line: string) {
    queueSpeech(line, null, null, true);
  }

  function queueSpeech(line: string, dots: number | null, face: Expression | null, passing: boolean) {
    state.pending = true;
    state.pendingLine = line;
    state.pendingDots = dots;
    state.pendingFace = face;
    state.pendingPassing = passing;
    flushSpeech();
  }

  function flushSpeech() {
    if (!state.pending || !state.motion.speechReady) return;
    state.pending = false;
    state.typingFace = state.pendingFace;
    state.passingFor = state.pendingPassing ? PASSING_SECONDS : 0;
    bubble.say(state.pendingLine, state.pendingDots);
  }

  useFrame((_, delta) => {
    if (state.broken) return;
    try {
      frame(delta);
    } catch (error) {
      state.broken = true;
      holder.visible = false;
      bubble.group.visible = false;
      console.error('Buddy stopped', error);
    }
  });

  /** Locks Buddy to the hand's left once the hand is still during a step; lets go when the hand moves on or the flow ends. */
  function updateWorkLock(dt: number, tracked: boolean, working: boolean) {
    const link = woundLink;
    if (tracked) {
      if (state.handSeen) {
        const speed = link.point.distanceTo(state.handPrev) / Math.max(dt, 1e-4);
        state.handSpeed += (speed - state.handSpeed) * (1 - Math.exp(-8 * dt));
      }
      state.handPrev.copy(link.point);
      state.handSeen = true;
      state.stillFor = state.handSpeed < STILL_SPEED ? state.stillFor + dt : 0;
    }
    if (!working) {
      state.locked = false;
      return;
    }
    if (state.locked) {
      if (tracked && link.point.distanceTo(state.lockHand) > UNLOCK_MOVE) {
        state.locked = false;
        state.stillFor = 0;
      }
      return;
    }
    if (tracked && state.stillFor > STILL_SECONDS) {
      const input = state.input;
      state.locked = true;
      state.lockHand.copy(link.point);
      state.left.copy(input.right).negate();
      buddyTarget(state.lockPoint, input.eye, input.gaze, link.point, state.left, WORK_SIDE);
    }
  }

  function frame(delta: number) {
    const r = rig;
    const presenting = gl.xr.isPresenting;
    holder.visible = !!r && active && presenting;
    if (!r || !holder.visible) {
      bubble.setOpacity(0);
      return;
    }
    const dt = Math.min(delta, MAX_DT);
    const link = woundLink;
    const flow = link.flow;
    const motion = state.motion;
    const input = state.input;

    // The head.
    const head = gl.xr.getCamera();
    head.getWorldPosition(input.eye);
    input.gaze.set(0, 0, -1).applyQuaternion(head.getWorldQuaternion(state.headTurn));
    input.right.setFromMatrixColumn(head.matrixWorld, 0).normalize();
    input.up.setFromMatrixColumn(head.matrixWorld, 1).normalize();

    // Home: the placement rules (beside the hand, clear of the wound, in view; ahead of the eyes without the hand).
    const hand = link.tracked || (link.placed && state.lostFor < LOST_AFTER);
    // Working (a step shown, the hand still): park to the hand's left, out of the way, and stay.
    const wasLocked = state.locked;
    updateWorkLock(dt, link.tracked, (flow?.stage ?? 0) > 0);
    if (state.locked) input.home.copy(state.lockPoint);
    else buddyTarget(input.home, input.eye, input.gaze, hand ? link.point : null, link.thumbSide);
    input.wound = link.placed ? link.point : null;
    input.watchWound = link.otherInRange;
    input.facingViewer = bubble.hasMessage && !motion.asleep;
    // Any expression faces the viewer: a reaction, talking, an occasion's clip, or curiosity at a coming pinch.
    input.expressive =
      !motion.asleep && (state.eventFor > 0 || (bubble.typing && bubble.hasMessage) || !!state.current || link.otherInRange);
    input.idle = !state.current && !bubble.typing && !state.pending && link.tracked && !state.locked;
    if (!state.entered) {
      // Session start: fly in from the side of the view (the hand's side, if known).
      state.entered = true;
      motion.enter(input, hand ? Math.sign(state.scratch.subVectors(link.point, input.eye).dot(input.right)) || 1 : 1);
    }

    // The wound hand.
    if (link.tracked) {
      if (state.asleep) {
        state.asleep = false;
        setBase(r, 'Idle_Float');
        react('surprised', 0.6);
        motion.wake();
      }
      state.lostFor = 0;
      if (!state.greeted) {
        state.greeted = true;
        react('happy', 2);
        if (motion.travelling) state.waveOnLanding = true;
        else play(r, 'Wave');
        say(BUDDY_LINES.hello, null, null);
      }
    } else {
      state.lostFor += dt;
      if (state.greeted && !state.asleep && state.lostFor > SLEEP_AFTER) {
        state.asleep = true;
        setBase(r, 'Sleepy');
        motion.sleep(input.eye);
      }
    }

    // The step flow's occasions, each with its move.
    if (flow && flow.steps !== state.steps) {
      state.steps = flow.steps;
      const stage = flow.stage;
      if (stage === 0) {
        // Done: a lap of honour round the hand, then bounce at home (just a bounce where it is if you were working).
        react('love', 2.5);
        if (link.placed && !wasLocked) {
          motion.orbitHand(link.point, input.right, input.up);
          state.bounceOnLanding = true;
        } else play(r, 'Happy_Bounce', 2);
        say(BUDDY_LINES.done, null, null);
      } else {
        if (!state.started) {
          state.started = true;
          play(r, 'Excited');
          react('excited', 0.7);
        }
        // A nod where it is: it never comes over to the hand while you work.
        play(r, 'Nod_Yes');
        say(STAGE_LABELS[stage], stage, 'determined');
      }
    }
    if (flow && flow.misses !== state.misses) {
      state.misses = flow.misses;
      play(r, 'Shake_No');
      react('confused', 2);
      motion.wobble();
      sayPassing(BUDDY_LINES.closer);
    }

    // Move.
    const event = motion.update(dt, input);
    if (event === 'visitArrived') play(r, 'Nod_Yes');
    if (event === 'arrived') {
      if (state.waveOnLanding) {
        state.waveOnLanding = false;
        play(r, 'Wave');
      }
      if (state.bounceOnLanding) {
        state.bounceOnLanding = false;
        play(r, 'Happy_Bounce', 2);
      }
    }
    flushSpeech();
    holder.position.copy(motion.position);
    holder.quaternion.copy(motion.quaternion);
    r.body.scale.copy(r.bodyScale).multiply(motion.stretch);

    // Flapping while flying: Idle_Float gives way to Excited with speed (not over an occasion's clip).
    const flap = state.current ? 0 : FLAP_WEIGHT * motion.speed01;
    if (r.flap) r.flap.weight = flap;
    const idle = r.actions.get('Idle_Float');
    if (idle && state.base === 'Idle_Float') idle.weight = IDLE_WEIGHT * (1 - flap / FLAP_WEIGHT * 0.8);

    // The flower: the step flow's progress.
    const goal = GROWTH[growthForStage(flow?.stage ?? 0, state.started)];
    const k = dt / GROW_SECONDS;
    for (let i = 0; i < 3; i++) state.growth[i] += THREE.MathUtils.clamp(goal[i] - state.growth[i], -k, k);
    for (const mesh of r.sprouts) {
      for (let i = 0; i < 3; i++) mesh.morphTargetInfluences![mesh.morphTargetDictionary![GROWTH_TARGETS[i]]] = state.growth[i];
    }

    // Speech: a passing line gives way to the standing one.
    bubble.update(dt);
    if (state.passingFor > 0 && !bubble.typing) {
      state.passingFor -= dt;
      if (state.passingFor <= 0) bubble.say(state.line, state.lineDots, true);
    }
    const talking = bubble.typing && bubble.hasMessage && !state.asleep;

    // The face: a reaction, else the line's face while it types, else curious near a pinch, else happy (or asleep).
    state.eventFor -= dt;
    let face: Expression = state.asleep
      ? 'sleepy'
      : state.eventFor > 0
        ? state.eventFace
        : talking && state.typingFace
          ? state.typingFace
          : link.otherInRange
            ? 'curious'
            : 'happy';
    state.talkClock = talking ? state.talkClock + dt : 0;
    if (talking && Math.floor(state.talkClock / TALK_FLIP) % 2 === 1) face = 'talk';
    state.blinkIn -= dt;
    if (state.blinkIn <= 0) {
      state.blinkIn = 2.2 + Math.random() * 3;
      if (!NO_BLINK.has(face) && face !== 'talk') state.blinkFor = BLINK_SECONDS;
    }
    if (state.blinkFor > 0) {
      state.blinkFor -= dt;
      if (!NO_BLINK.has(face) && face !== 'talk') face = 'blink';
    }
    if (r.face?.map && face !== state.expression) {
      state.expression = face;
      r.face.map.offset.copy(expressionOffset(face, state.offset));
    }

    r.mixer.update(dt);

    // The bubble: beside Buddy on the side away from the wound, following with a little lag, upright and turned to the viewer.
    const speaking = bubble.hasMessage && !motion.asleep;
    bubble.setOpacity(speaking ? motion.bubbleOpacity : 0);
    if (!speaking) {
      state.bubblePlaced = false;
      return;
    }
    if (hand) {
      const across = state.scratch.subVectors(holder.position, link.point).dot(input.right);
      if (Math.abs(across) > SIDE_SWITCH) state.bubbleSide = across >= 0 ? 1 : -1;
    }
    const half = BUDDY_SIZE_CM / 200;
    state.bubbleGoal
      .copy(holder.position)
      .addScaledVector(input.right, state.bubbleSide * (half + BUBBLE_GAP + bubble.width / 2))
      .addScaledVector(input.up, 0.02);
    if (!state.bubblePlaced) {
      state.bubbleAt.copy(state.bubbleGoal);
      state.bubbleVel.set(0, 0, 0);
      state.bubblePlaced = true;
    }
    springStep(state.bubbleAt, state.bubbleVel, state.bubbleGoal, dt);
    bubble.group.position.copy(state.bubbleAt);
    bubble.group.quaternion.copy(state.headTurn);
    bubble.setTailSide(state.bubbleSide === 1 ? -1 : 1);
  }

  return (
    <>
      <primitive object={holder} />
      <primitive object={bubble.group} />
    </>
  );
}
