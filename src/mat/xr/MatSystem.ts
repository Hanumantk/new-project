import * as THREE from 'three';
import type { Kit } from '../lib/kit';
import { clearSavedMat, loadOpacity, saveMat, saveOpacity, type SavedMat } from '../lib/matStore';
import { PalmUpToggle } from '../lib/palmUp';
import { PinchDetector } from '../lib/pinch';
import { fitRectangle, isBigEnough, orientToViewer, type MatPlacement } from '../lib/rectFit';
import { StrokeBuffer } from '../lib/stroke';
import { medianY, pointInPolygon, surfaceFromPen } from '../lib/surface';
import { ControlPanel, type PanelButton } from './ControlPanel';
import { HandTracker, type HandState } from './hands';
import { HintBoard } from './HintBoard';
import { MatView } from './MatView';
import { StrokeView } from './StrokeView';
import { detectedHorizontalPlanes, findSurfacePlane, SurfaceProbe } from './surfaceProbe';

export interface MatSystemEvents {
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
/** How long the drawing prompt shows (s); the injury session has its own hints too. */
const DRAW_HINT_TIME = 10;
/** How quickly the overlay follows the opacity slider (1/s). */
const OPACITY_RATE = 12;
/** Fingertip radius assumed when the stroke has no hand (the ?test trace). */
const DEFAULT_PEN_RADIUS = 0.008;

const DRAW_TITLE = 'Lay out your materials';
const DRAW_DETAIL = 'Pinch thumb and index on your table, trace a rectangle (at least 25 × 20 cm), then let go.';

const cm = (m: number) => Math.round(m * 100);

/**
 * The material mat, inside the injury simulation's mixed-reality session:
 * pinch-trace a rectangle on the table and the kit is laid out on it. It
 * adds `root` to the scene and is updated from the scene's XR frames; the
 * session and renderer are the injury simulation's.
 */
export class MatSystem {
  /** Everything the mat draws; add it to the scene once. */
  readonly root = new THREE.Group();
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly hint = new HintBoard();
  private readonly hands = new HandTracker();
  private readonly pinches = { left: new PinchDetector(), right: new PinchDetector() };
  private readonly stroke = new StrokeBuffer();
  private readonly strokeView = new StrokeView();
  private readonly probe = new SurfaceProbe();
  private readonly mat = new MatView();
  private readonly panel: ControlPanel;
  private readonly handList: readonly HandState[];
  private readonly palmUp = new PalmUpToggle();

  private session: XRSession | null = null;
  private kit: Kit | null = null;
  private phase: Phase = 'draw';
  private lastTime = 0;
  /** The hand drawing the current stroke. */
  private pen: HandState | null = null;
  private restoreWaited = 0;
  private stepMode = false;
  /** Index of the current item in step mode. */
  private step = 0;
  private opacityTarget = 1;
  private opacityShown = 1;

  private anchor: XRAnchor | null = null;
  private readonly anchorSpaces: XRSpace[] = [];
  private readonly anchorPose = new Float32Array(16);
  private savedHandle: string | null = null;
  /** Bumped on every redraw so late anchor promises from an old mat are ignored. */
  private generation = 0;
  private testTraceRequested = false;

  private readonly head = new THREE.Vector3();
  private readonly headMatrix = new THREE.Matrix4();

  constructor(private readonly events: MatSystemEvents = {}) {
    this.panel = new ControlPanel({
      onOpacity: (value, done) => {
        this.opacityTarget = value;
        if (done) saveOpacity(value);
      },
      onButton: (button) => this.onPanelButton(button),
    });
    this.mat.root.add(this.panel.group);
    this.handList = [this.hands.left, this.hands.right];
    this.root.add(this.hint.group, this.strokeView.group, this.mat.root);
    this.root.visible = false;
    if (import.meta.env.DEV) (window as unknown as { __mat?: MatSystem }).__mat = this;
  }

  get active() {
    return this.session !== null;
  }

  /** Starts with a running mixed-reality session (rendered by `renderer`). */
  start(session: XRSession, renderer: THREE.WebGLRenderer, options: StartOptions) {
    this.session = session;
    this.renderer = renderer;
    if (options.kit !== this.kit) {
      this.kit = options.kit;
      this.mat.setKit(options.kit);
    }
    this.opacityTarget = this.opacityShown = loadOpacity();
    this.mat.setOpacity(this.opacityShown);
    this.lastTime = 0;
    this.root.visible = true;
    this.resetToDraw();
    if (options.restore) this.restore(session, options.restore);
  }

  /** The session ended: anchors die with it (a persistent one can be restored next time). */
  stop() {
    this.probe.cancel();
    this.anchor = null;
    this.session = null;
    this.renderer = null;
    this.root.visible = false;
    this.mat.setVisible(false);
    this.hint.hide();
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

  /**
   * Test aid (the page's ?test mode, for the emulator): next frame, trace a
   * 60 × 40 cm rectangle on the table 50 cm ahead as if it had been
   * pinch-drawn, then place it through the usual steps.
   */
  traceTestRectangle() {
    if (this.phase === 'draw') this.testTraceRequested = true;
  }

  private resetToDraw() {
    this.generation++;
    this.phase = 'draw';
    this.stepMode = false;
    this.pen = null;
    this.stroke.reset();
    this.probe.cancel();
    this.mat.setVisible(false);
    this.hint.show(DRAW_TITLE, DRAW_DETAIL, DRAW_HINT_TIME);
  }

  /** Per XR frame, before the scene renders. `time` in ms. */
  update(time: number, frame: XRFrame) {
    const space = this.renderer?.xr.getReferenceSpace();
    if (!this.session || !space) return;
    const dt = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = time;
    this.readHead();
    this.hands.update(frame, space);
    const leftEvent = this.pinches.left.update(this.hands.left.tracked ? this.hands.left.pinchDistance : null, dt);
    const rightEvent = this.pinches.right.update(this.hands.right.tracked ? this.hands.right.pinchDistance : null, dt);

    switch (this.phase) {
      case 'draw':
        if (this.testTraceRequested) {
          this.testTraceRequested = false;
          this.runTestTrace(frame, space);
        } else if (rightEvent === 'start') this.beginStroke(this.hands.right);
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
          this.showControls();
          this.mat.setVisible(true);
          this.hint.show('Found your last mat', `${cm(this.mat.width)} × ${cm(this.mat.depth)} cm`, 3);
        } else if (this.restoreWaited > RESTORE_TIMEOUT) {
          this.restoreFailed();
        }
        break;
      case 'placed':
        this.trackAnchor(frame, space);
        this.updateControls(dt);
        break;
    }
    this.mat.update(this.head, time / 1000);

    this.strokeView.update(dt);
    this.hint.update(dt, this.head, this.headMatrix);
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
    const plane = findSurfacePlane(frame, space, x, z, penY, this.pen?.penRadius ?? DEFAULT_PEN_RADIUS);
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
    return surfaceFromPen(medianY(this.stroke.positions, this.stroke.count), this.pen?.penRadius ?? DEFAULT_PEN_RADIUS);
  }

  private runTestTrace(frame: XRFrame, space: XRReferenceSpace) {
    const e = this.headMatrix.elements;
    let fx = -e[8];
    let fz = -e[10];
    const length = Math.hypot(fx, fz) || 1;
    fx /= length;
    fz /= length;
    const cx = this.head.x + fx * 0.5;
    const cz = this.head.z + fz * 0.5;
    // The highest detected table under that point, else a seated desk 45 cm below the eyes.
    let tableY = this.head.y - 0.45;
    let found = false;
    for (const plane of detectedHorizontalPlanes(frame, space)) {
      if (plane.y < this.head.y - 0.15 && (!found || plane.y > tableY) && pointInPolygon(cx, cz, plane.polygon)) {
        tableY = plane.y;
        found = true;
      }
    }
    const penY = tableY + DEFAULT_PEN_RADIUS;
    // Corners of 60 × 40 cm, the width across the view; walk the outline every 1 cm.
    const corners = [
      [-0.3, -0.2],
      [0.3, -0.2],
      [0.3, 0.2],
      [-0.3, 0.2],
      [-0.3, -0.2],
    ];
    this.pen = null;
    this.stroke.reset();
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k];
      const [bx, bz] = corners[k + 1];
      for (let i = 0; i < 60; i++) {
        const t = i / 60;
        const lx = ax + (bx - ax) * t; // across: along (−fz, fx)
        const lz = az + (bz - az) * t; // away: along −forward
        this.stroke.add(cx - fz * lx - fx * lz, penY, cz + fx * lx - fz * lz);
      }
    }
    this.strokeView.begin();
    this.strokeView.sync(this.stroke);
    this.hint.hide();
    this.finishStroke(frame, space);
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
    this.showControls();
  }

  private showControls() {
    this.panel.placeFor(this.mat.width, this.mat.depth);
    this.panel.group.visible = true;
    this.refreshPanel();
  }

  /** Per frame while the mat is down: panel pokes, the palm-up toggle, the opacity fade. */
  private updateControls(dt: number) {
    const left = this.hands.left;
    // Only while the right hand is tracked: then the wound is on the right
    // palm, and turning the left palm up isn't someone looking at the wound.
    const busy = !left.tracked || left.pinchDistance < 0.03 || !this.hands.right.tracked;
    if (this.palmUp.update(busy ? null : left.palmNormal.y, dt)) {
      this.panel.group.visible = !this.panel.group.visible;
      if (!this.panel.group.visible) this.hint.show('Controls hidden', 'Turn your left palm up again to bring them back.', 3);
      else this.hint.hide();
    }
    if (this.panel.group.visible) this.panel.update(dt, this.handList);
    if (this.opacityShown !== this.opacityTarget) {
      this.opacityShown += (this.opacityTarget - this.opacityShown) * (1 - Math.exp(-OPACITY_RATE * dt));
      if (Math.abs(this.opacityShown - this.opacityTarget) < 0.003) this.opacityShown = this.opacityTarget;
      this.mat.setOpacity(this.opacityShown);
    }
  }

  private onPanelButton(button: PanelButton) {
    const count = this.mat.itemCount;
    switch (button) {
      case 'redraw':
        this.redraw();
        return;
      case 'step':
        this.stepMode = !this.stepMode;
        // Start from the first item on the page in view.
        if (this.stepMode) this.step = Math.max(this.firstItemOnPage(this.mat.page), 0);
        break;
      case 'prev':
      case 'next': {
        const delta = button === 'next' ? 1 : -1;
        if (this.stepMode) this.step = Math.min(Math.max(this.step + delta, 0), count - 1);
        else this.mat.setPage(this.mat.page + delta);
        break;
      }
    }
    this.mat.setActiveStep(this.stepMode ? this.step : -1);
    this.refreshPanel();
  }

  private firstItemOnPage(page: number) {
    for (let i = 0; i < this.mat.itemCount; i++) if (this.mat.pageOf(i) === page) return i;
    return -1;
  }

  private refreshPanel() {
    const count = this.mat.itemCount;
    const { page, pages } = this.mat;
    let status: string;
    if (this.stepMode) {
      const item = this.kit?.items[this.step];
      status = `Step ${item?.step ?? this.step + 1} of ${count} · ${item?.name ?? ''}`;
    } else if (pages > 1) {
      status = `Page ${page + 1} of ${pages} · ${this.kit?.title ?? ''}`;
    } else {
      status = `All ${count} items · ${this.kit?.title ?? ''}`;
    }
    this.panel.setState({
      opacity: this.opacityTarget,
      stepMode: this.stepMode,
      canPrev: this.stepMode ? this.step > 0 : page > 0,
      canNext: this.stepMode ? this.step < count - 1 : page < pages - 1,
      status,
    });
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
    this.panel.group.visible = false;
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
    this.hint.show('Couldn’t find your last mat here', 'Pinch and trace a new one.', DRAW_HINT_TIME, 'warn');
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
    if (!this.renderer) return;
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
