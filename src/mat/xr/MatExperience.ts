import * as THREE from 'three';
import { HintBoard } from './HintBoard';

export interface MatExperienceEvents {
  /** The session ended (the user left it, or it failed). */
  onEnd: () => void;
}

/**
 * The headset side of the Material Mat: one three.js renderer with a
 * transparent clear colour so passthrough shows, driven by the XR frame loop.
 */
export class MatExperience {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 20);
  private readonly hint = new HintBoard();
  private session: XRSession | null = null;
  private lastTime = 0;

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
    this.scene.add(sun, this.hint.group);
  }

  get active() {
    return this.session !== null;
  }

  /** Takes over a freshly granted session. */
  async start(session: XRSession) {
    this.session = session;
    session.addEventListener('end', this.handleEnd);
    await this.renderer.xr.setSession(session);
    this.lastTime = 0;
    this.renderer.setAnimationLoop(this.onFrame);
    this.hint.show('Pinch and trace a rectangle on your table', 'Hold thumb and index together, draw around the area, then let go.');
  }

  end() {
    void this.session?.end().catch(() => {});
  }

  dispose() {
    this.end();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
  }

  private readonly handleEnd = () => {
    this.renderer.setAnimationLoop(null);
    this.session = null;
    this.events.onEnd();
  };

  private readonly onFrame = (time: number, frame?: XRFrame) => {
    if (!frame) return;
    const dt = this.lastTime ? Math.min((time - this.lastTime) / 1000, 0.1) : 0;
    this.lastTime = time;
    this.readHead();
    this.hint.update(dt, this.head, this.headMatrix);
    this.renderer.render(this.scene, this.camera);
  };

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
