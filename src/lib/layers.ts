/**
 * Render layers used by the webcam compositor. Layer 0 is the main pass
 * (camera picture, bruise, depth stand-ins); the wound is drawn separately
 * so it can be softened and given grain before it's laid over the picture.
 */
export const LAYER_MAIN = 0;
// Layers 1 and 2 are used by three.js for the left/right eye in WebXR.
/** The lit wound (cut, blood, torn skin): rendered into its own target. */
export const LAYER_WOUND = 10;
/** Depth stand-ins for the hand: needed in both passes. */
export const LAYER_OCCLUDER = 11;
/** Debug overlays (palm wireframe): drawn last, unprocessed. */
export const LAYER_DEBUG = 12;
