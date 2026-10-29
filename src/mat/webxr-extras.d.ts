/** WebXR members the Quest Browser has that @types/webxr lacks. */
interface XRFrame {
  /** Hand input: fills 16 floats per space with its pose in baseSpace. */
  fillPoses?(spaces: XRSpace[], baseSpace: XRSpace, transforms: Float32Array): boolean;
  /** Hand input: fills one radius per joint space. */
  fillJointRadii?(jointSpaces: XRJointSpace[], radii: Float32Array): boolean;
}
