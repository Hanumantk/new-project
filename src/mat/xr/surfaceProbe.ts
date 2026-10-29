import { SURFACE_ABOVE, SURFACE_BELOW, pickSurfacePlane, type HorizontalPlane } from '../lib/surface';

/** Horizontal planes the headset has detected, in `space` (empty without plane detection). */
export function detectedHorizontalPlanes(frame: XRFrame, space: XRReferenceSpace): HorizontalPlane[] {
  const planes: HorizontalPlane[] = [];
  const detected = frame.detectedPlanes;
  if (!detected) return planes;
  detected.forEach((plane) => {
    if (plane.orientation !== 'horizontal') return;
    const pose = frame.getPose(plane.planeSpace, space);
    if (!pose) return;
    const m = pose.transform.matrix;
    // Plane space +Y is the plane's normal: keep surfaces facing up (not ceilings).
    if (m[5] < 0.9) return;
    const polygon: number[] = [];
    for (const p of plane.polygon) {
      polygon.push(m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12], m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]);
    }
    planes.push({ y: m[13], polygon });
  });
  return planes;
}

export function findSurfacePlane(
  frame: XRFrame,
  space: XRReferenceSpace,
  centreX: number,
  centreZ: number,
  penY: number,
  tipRadius: number,
): number | null {
  const plane = pickSurfacePlane(detectedHorizontalPlanes(frame, space), centreX, centreZ, penY, tipRadius);
  return plane ? plane.y : null;
}

/** How long to wait for a hit-test answer before falling back (s). */
const PROBE_TIMEOUT = 0.6;

/**
 * Asks the headset's hit test (its scene mesh) for the surface straight
 * below a point — the fallback when no detected plane fits.
 */
export class SurfaceProbe {
  private source: XRHitTestSource | null = null;
  private waited = 0;
  private penY = 0;
  private done = false;
  private failed = false;

  /** Starts a probe down from just above (x, penY, z). Returns false if hit test isn't available. */
  begin(session: XRSession, space: XRReferenceSpace, x: number, penY: number, z: number): boolean {
    this.cancel();
    this.done = false;
    this.failed = false;
    this.waited = 0;
    this.penY = penY;
    if (!session.requestHitTestSource || !session.enabledFeatures?.includes('hit-test')) return false;
    const request = session.requestHitTestSource({
      space,
      offsetRay: new XRRay({ x, y: penY + 0.05, z, w: 1 }, { x: 0, y: -1, z: 0, w: 0 }),
    });
    if (!request) return false;
    request.then(
      (source) => {
        if (this.done) source.cancel();
        else this.source = source;
      },
      () => {
        this.failed = true;
      },
    );
    return true;
  }

  /**
   * The surface height once known; undefined while waiting; null when the
   * probe found nothing plausible or timed out.
   */
  poll(frame: XRFrame, space: XRReferenceSpace, dt: number): number | null | undefined {
    if (this.done) return null;
    this.waited += dt;
    if (this.failed || this.waited > PROBE_TIMEOUT) return this.finish(null);
    if (!this.source) return undefined;
    const results = frame.getHitTestResults(this.source);
    for (const result of results) {
      const y = result.getPose(space)?.transform.position.y;
      if (y !== undefined && y >= this.penY - SURFACE_BELOW && y <= this.penY + SURFACE_ABOVE) return this.finish(y);
    }
    return undefined;
  }

  cancel() {
    this.done = true;
    this.source?.cancel();
    this.source = null;
  }

  private finish(y: number | null) {
    this.cancel();
    return y;
  }
}
