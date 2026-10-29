import * as THREE from 'three';
import type { Kit } from '../lib/kit';
import { clearSavedMat, loadOpacity, saveMat, type SavedMat } from '../lib/matStore';
import { PinchDetector } from '../lib/pinch';
import { fitRectangle, isBigEnough, orientToViewer, type MatPlacement } from '../lib/rectFit';
import { StrokeBuffer } from '../lib/stroke';
import { medianY, surfaceFromPen } from '../lib/surface';
import { HandTracker, type HandState } from './hands';
import { HintBoard } from './HintBoard';
import { MatView } from './MatView';
import { StrokeView } from './StrokeView';
import { findSurfacePlane, SurfaceProbe } from './surfaceProbe';

export interface MatExperienceEvents {
  /** The session ended (the user left it, or it failed). */
  onEnd: () => void;
  /** A mat was saved for restoring later (or cleared, with null). */
  onSavedMatChange?: (mat: SavedMat | null) => void;
}

export interface StartOptions {
  /** What to lay out on the mat. */
  kit: Kit;
  /** Restore this mat from its persistent anchor instead of drawing a new one. */
  restore?: SavedMat | null;
}

/**
 * draw: waiting for a pinch · drawing: recording the stroke · settling:
 * waiting on the table height · placed: the mat is on the table ·
 * restoring: looking for a saved mat.
 */
type Phase = 'draw' | 'drawing' | 'settling' | 'placed' | 'restoring';

/** Fewer pen points than this is an accidental pinch, not a drawing. */
const MIN_STROKE_POINTS = 12;
/** Pen points more than this above the table are the hand arriving or leaving. */
const STROKE_LIFT = 0.04;
/** Give up looking for a restored mat after this long (s). */
const RESTORE_TIMEOUT = 12;
/** Show the "use your hands" hint after this long without hands (s). */
const NO_HANDS_HINT_AFTER = 1.5;

const DRAW_TITLE = 'Pinch and trace a rectangle on your table';
const DRAW_DETAIL = 'Hold thumb and index together, draw around the area, then let go. At least 25 × 20 cm.';

const cm = (m: number) => Math.round(m * 100);

/**
 * The headset side of the Material Mat: one three.js renderer with a
 * transparent clear colour so passthrough shows, driven by the XR frame loop.
 */
export class MatExperience {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 20);
  private readonly hint = new HintBoard();
  private readonly hands = new HandTracker();
  private readonly pinches = { left: new PinchDetector(), right: new PinchDetector() };
  private readonly stroke = new StrokeBuffer();
  private readonly strokeView = new StrokeView();
  private readonly probe = new SurfaceProbe();
  private readonly mat = new MatView();

  private session: XRSession | null = null;
  private kit: Kit | null = null;
  private phase: Phase = 'draw';
  private lastTime = 0;
  /** The hand drawing the current stroke. */
  private pen: HandState | null = null;
  private noHandsFor = 0;
  private restoreWaited = 0;

  private anchor: XRAnchor | null = null;
  private readonly anchorSpaces: XRSpace[] = [];
  private readonly anchorPose = new Float32Array(16);
  private savedHandle: string | null = null;
  /** Bumped on every redraw so late anchor promises from an old mat are ignored. */
  private generation = 0;

  private readonly head = new THREE.Vector3();
  private readonly headMatrix = new THREE.Matrix4();

  constructor(private readonly events: MatExperienceEvents) {
    const canvas = document.createElement('canvas');
    const attributes = { alpha: true, antialias: true, xrCompatible: true } as const;
    const context = canvas.getContext('webgl2', attributes) as WebGL2RenderingContext | null;
    this.renderer = new THREE.WebGLRenderer({ canvas, ...attributes, ...(context ? { context } : {}) });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#5b6660', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(0.4, 2, 0.6);
    this.scene.add(sun, this.hint.group, this.strokeView.group, this.mat.root);
    if (import.meta.env.DEV) (window as unknown as { __mat?: MatExperience }).__mat = this;
  }

  get active() {
    return this.session !== null;
  }

  /** Takes over a freshly granted session. */
  async start(session: XRSession, options: StartOptions) {
    this.session = session;
    if (options.kit !== this.kit) {
      this.kit = options.kit;
      this.mat.setKit(options.kit);
    }
    this.mat.setOpacity(loadOpacity());
    session.addEventListener('end', this.handleEnd);
    await this.renderer.xr.setSession(session);
    this.lastTime = 0;
    this.resetToDraw();
    if (options.restore) this.restore(session, options.restore);
    this.renderer.setAnimationLoop(this.onFrame);
  }

  end() {
    void this.session?.end().catch(() => {});
  }

  dispose() {
    this.end();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
  }

  /** Removes the mat (and its saved anchor) and starts drawing again. */
  redraw() {
    const session = this.session;
    this.anchor?.delete();
    this.anchor = null;
    if (this.savedHandle && session?.deletePersistentAnchor) {
      void session.deletePersistentAnchor(this.savedHandle).catch(() => {});
    }
    if (this.savedHandle) {
      this.savedHandle = null;
      clearSavedMat();
      this.events.onSavedMatChange?.(null);
    }
    this.resetToDraw();
  }

  private resetToDraw() {
    this.generation++;
    this.phase = 'draw';
    this.pen = null;
    this.stroke.reset();
    this.probe.cancel();
    this.mat.setVisible(false);
    this.hint.show(DRAW_TITLE, DRAW_DETAIL);
  }

  private readonly handleEnd = () => {
    this.renderer.setAnimationLoop(null);
    this.probe.cancel();
    // Anchors die with the session; a persistent one can be restored next time.
    this.anchor = null;
    this.session = null;
    this.events.onEnd();
  };

  private readonly onFrame = (time: number, frame?: XRFrame) => {
    const space = this.renderer.xr.getReferenceSpace();
    if (!frame || !space) return;
    const dt = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = time;
    this.readHead();
    this.hands.update(frame, space);
    const leftEvent = this.pinches.left.update(this.hands.left.tracked ? this.hands.left.pinchDistance : null, dt);
    const rightEvent = this.pinches.right.update(this.hands.right.tracked ? this.hands.right.pinchDistance : null, dt);

    switch (this.phase) {
      case 'draw':
        this.watchForHands(dt);
        if (rightEvent === 'start') this.beginStroke(this.hands.right);
        else if (leftEvent === 'start') this.beginStroke(this.hands.left);
        break;
      case 'drawing': {
        const hand = this.pen!;
        if (hand.tracked) this.stroke.add(hand.pen.x, hand.pen.y, hand.pen.z);
        this.strokeView.sync(this.stroke);
        const event = hand === this.hands.right ? rightEvent : leftEvent;
        if (event === 'end') this.finishStroke(frame, space);
        break;
      }
      case 'settling': {
        const y = this.probe.poll(frame, space, dt);
        if (y !== undefined) this.place(frame, space, y ?? this.penSurface());
        break;
      }
      case 'restoring':
        this.restoreWaited += dt;
        if (this.trackAnchor(frame, space)) {
          this.phase = 'placed';
          this.mat.setVisible(true);
          this.hint.show('Found your last mat', `${cm(this.mat.width)} × ${cm(this.mat.depth)} cm`, 3);
        } else if (this.restoreWaited > RESTORE_TIMEOUT) {
          this.restoreFailed();
        }
        break;
      case 'placed':
        this.trackAnchor(frame, space);
        break;
    }
    this.mat.update(this.head, time / 1000);

    this.strokeView.update(dt);
    this.hint.update(dt, this.head, this.headMatrix);
    this.renderer.render(this.scene, this.camera);
  };

  private watchForHands(dt: number) {
    if (this.hands.left.tracked || this.hands.right.tracked) {
      if (this.noHandsFor >= NO_HANDS_HINT_AFTER) this.hint.show(DRAW_TITLE, DRAW_DETAIL);
      this.noHandsFor = 0;
      return;
    }
    this.noHandsFor += dt;
    if (this.noHandsFor >= NO_HANDS_HINT_AFTER && this.noHandsFor - dt < NO_HANDS_HINT_AFTER) {
      this.hint.show('Put the controllers down', 'The mat is drawn and used with your hands.');
    }
  }

  private beginStroke(hand: HandState) {
    this.pen = hand;
    this.phase = 'drawing';
    this.stroke.reset();
    this.stroke.add(hand.pen.x, hand.pen.y, hand.pen.z);
    this.strokeView.begin();
    this.hint.hide();
  }

  /** Works out the table height under the stroke: a detected plane, else hit test, else the pen. */
  private finishStroke(frame: XRFrame, space: XRReferenceSpace) {
    if (this.stroke.count < MIN_STROKE_POINTS) {
      this.strokeView.fadeOut();
      this.resetToDraw();
      return;
    }
    const { x, z } = this.strokeCentre();
    const penY = medianY(this.stroke.positions, this.stroke.count);
    const plane = findSurfacePlane(frame, space, x, z, penY, this.pen!.penRadius);
    if (plane !== null) {
      this.place(frame, space, plane);
      return;
    }
    if (this.session && this.probe.begin(this.session, space, x, penY, z)) {
      this.phase = 'settling';
      return;
    }
    this.place(frame, space, this.penSurface());
  }

  /** Table height from the pen alone: its median height, one fingertip radius down. */
  private penSurface() {
    return surfaceFromPen(medianY(this.stroke.positions, this.stroke.count), this.pen?.penRadius ?? 0.008);
  }

  private strokeCentre() {
    const p = this.stroke.positions;
    let x = 0;
    let z = 0;
    for (let i = 0; i < this.stroke.count; i++) {
      x += p[i * 3];
      z += p[i * 3 + 2];
    }
    return { x: x / this.stroke.count, z: z / this.stroke.count };
  }

  /** Fits the rectangle on the table at height y and puts the mat there. */
  private place(frame: XRFrame, space: XRReferenceSpace, y: number) {
    const p = this.stroke.positions;
    const rect = fitRectangle(p, this.stroke.count, (i) => p[i * 3 + 1] < y + STROKE_LIFT);
    this.strokeView.fadeOut();
    if (!rect) {
      this.resetToDraw();
      return;
    }
    const placement = orientToViewer(rect, this.head.x, this.head.z);
    if (!isBigEnough(placement.width, placement.depth)) {
      this.resetToDraw();
      this.hint.show(
        `Too small: ${cm(placement.width)} × ${cm(placement.depth)} cm`,
        'Draw at least 25 × 20 cm. Pinch and trace again.',
        Infinity,
        'warn',
      );
      return;
    }
    this.showMat(placement, y);
    this.anchorMat(frame, space, placement, y);
    this.hint.show(
      `Mat placed · ${cm(placement.width)} × ${cm(placement.depth)} cm`,
      'Put each item on its outline.',
      4,
    );
  }

  private showMat(placement: MatPlacement, y: number) {
    this.mat.build(placement.width, placement.depth);
    this.mat.setPose(placement.cx, y, placement.cz, placement.yaw);
    this.mat.setVisible(true);
    this.phase = 'placed';
  }

  /** Locks the mat to the table with an anchor (kept across sessions when supported). */
  private anchorMat(frame: XRFrame, space: XRReferenceSpace, placement: MatPlacement, y: number) {
    if (!frame.createAnchor) return; // No anchors: the mat stays at its reference-space pose.
    const generation = this.generation;
    const half = placement.yaw / 2;
    const pose = new XRRigidTransform(
      { x: placement.cx, y, z: placement.cz, w: 1 },
      { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
    );
    const request = frame.createAnchor(pose, space);
    if (!request) return;
    request.then(
      (anchor) => {
        if (generation !== this.generation || !this.session) {
          anchor.delete();
          return;
        }
        this.anchor = anchor;
        this.persist(anchor, placement.width, placement.depth);
      },
      (err: unknown) => console.warn('Anchor not created; the mat keeps its first pose.', err),
    );
  }

  private persist(anchor: XRAnchor, width: number, depth: number) {
    if (!anchor.requestPersistentHandle) return;
    const generation = this.generation;
    const previous = this.savedHandle;
    anchor.requestPersistentHandle().then(
      (handle) => {
        if (generation !== this.generation) return;
        if (previous && previous !== handle) void this.session?.deletePersistentAnchor?.(previous).catch(() => {});
        this.savedHandle = handle;
        const saved = { handle, width, depth, savedAt: Date.now() };
        saveMat(saved);
        this.events.onSavedMatChange?.(saved);
      },
      (err: unknown) => console.warn('Mat anchor not saved for next time.', err),
    );
  }

  private restore(session: XRSession, saved: SavedMat) {
    if (!session.restorePersistentAnchor) {
      this.restoreFailed();
      return;
    }
    const generation = this.generation;
    this.phase = 'restoring';
    this.restoreWaited = 0;
    this.savedHandle = saved.handle;
    this.mat.build(saved.width, saved.depth);
    this.hint.show('Finding your last mat…', 'Look at the table where you left it.');
    session.restorePersistentAnchor(saved.handle).then(
      (anchor) => {
        if (generation !== this.generation) anchor.delete();
        else this.anchor = anchor;
      },
      (err: unknown) => {
        console.warn('Saved mat not found.', err);
        if (generation === this.generation) this.restoreFailed();
      },
    );
  }

  private restoreFailed() {
    this.anchor?.delete();
    this.anchor = null;
    this.resetToDraw();
    this.hint.show('Couldn’t find your last mat here', 'Pinch and trace a new one.', Infinity, 'warn');
  }

  /** Moves the mat to its anchor's latest pose. Returns whether the anchor is tracked. */
  private trackAnchor(frame: XRFrame, space: XRReferenceSpace): boolean {
    const anchor = this.anchor;
    if (!anchor) return false;
    if (frame.trackedAnchors && !frame.trackedAnchors.has(anchor)) return false;
    if (frame.fillPoses) {
      this.anchorSpaces[0] = anchor.anchorSpace;
      if (!frame.fillPoses(this.anchorSpaces, space, this.anchorPose)) return false;
      this.mat.setMatrix(this.anchorPose);
      return true;
    }
    const pose = frame.getPose(anchor.anchorSpace, space);
    if (!pose) return false;
    this.mat.setMatrix(pose.transform.matrix);
    return true;
  }

  /** Eye midpoint and head orientation, from the per-eye cameras three.js updated for this frame. */
  private readHead() {
    const cameras: readonly THREE.Camera[] = this.renderer.xr.getCamera().cameras;
    if (cameras.length === 0) return;
    const e = cameras[0].matrix.elements;
    this.headMatrix.copy(cameras[0].matrix);
    this.head.set(e[12], e[13], e[14]);
    if (cameras.length > 1) {
      const r = cameras[1].matrix.elements;
      this.head.set((e[12] + r[12]) / 2, (e[13] + r[13]) / 2, (e[14] + r[14]) / 2);
    }
  }
}
