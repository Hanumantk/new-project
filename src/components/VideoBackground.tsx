import { useEffect, useMemo, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { computeCover, createCoverRect } from '../lib/coverMapping';
import type { HandPose } from '../lib/handPose';
import type { TrackingState } from '../lib/tracking';

/**
 * Full-screen quad showing the captured camera frame — the very canvas the
 * latest detection ran on — with `object-fit: cover` maths, so the picture
 * and the wound pose always come from the same frame. Mirroring is done by
 * the CSS transform on the stage, exactly as it was for the <video>.
 */
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D frame;
  // Screen UV -> frame UV for the cover crop.
  uniform vec2 coverScale;
  uniform vec2 coverOffset;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(frame, vUv * coverScale + coverOffset);
    #include <colorspace_fragment>
  }
`;

interface VideoBackgroundProps {
  tracking: RefObject<TrackingState>;
  pose: RefObject<HandPose>;
}

export function VideoBackground({ tracking, pose }: VideoBackgroundProps) {
  const size = useThree((s) => s.size);
  const { mesh, material, scratch } = useMemo(() => {
    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        frame: { value: null },
        coverScale: { value: new THREE.Vector2(1, 1) },
        coverOffset: { value: new THREE.Vector2(0, 0) },
      },
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000; // before everything else
    return {
      mesh,
      material,
      scratch: { cover: createCoverRect(), texture: null as THREE.CanvasTexture | null, width: 0, height: 0 },
    };
  }, []);

  useEffect(
    () => () => {
      scratch.texture?.dispose();
      mesh.geometry.dispose();
      material.dispose();
    },
    [mesh, material, scratch],
  );

  useFrame(() => {
    const state = tracking.current;
    const frame = state?.frame;
    if (!state || !frame || state.frameId === 0) return; // nothing captured yet

    // GPU storage is sized on first upload, so recreate the texture if the
    // camera's resolution changes.
    if (
      !scratch.texture ||
      scratch.texture.image !== frame ||
      scratch.width !== frame.width ||
      scratch.height !== frame.height
    ) {
      scratch.texture?.dispose();
      const texture = new THREE.CanvasTexture(frame);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      scratch.texture = texture;
      scratch.width = frame.width;
      scratch.height = frame.height;
      material.uniforms.frame.value = texture;
    }
    const rendered = state.rendered;
    if (rendered.backgroundFrameId !== state.frameId) {
      scratch.texture.needsUpdate = true; // upload the newly captured frame
      rendered.backgroundFrameId = state.frameId;
    }
    // The wound pose was computed this render from the same tracking state;
    // count any render where the two disagree.
    const hand = pose.current;
    if (hand?.tracked) {
      rendered.poseFrameId = hand.frameId;
      if (hand.frameId !== rendered.backgroundFrameId) rendered.mismatches++;
    }

    // Cover crop: the frame is scaled to fill the view and centred.
    const cover = computeCover(scratch.cover, size.width, size.height, frame.width, frame.height);
    material.uniforms.coverScale.value.set(size.width / cover.width, size.height / cover.height);
    // Screen v=1 is the top row (frame y=0); frame textures have v=1 at the top too.
    material.uniforms.coverOffset.value.set(
      -cover.offsetX / cover.width,
      1 - (size.height - cover.offsetY) / cover.height,
    );
  });

  return <primitive object={mesh} />;
}
