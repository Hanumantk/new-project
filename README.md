# Palm injury — AR hand-tracking prototype

A single-page React + TypeScript app that uses your webcam, tracks your hand in
real time with MediaPipe's **HandLandmarker**, and renders a realistic wound
on your palm (three.js via **@react-three/fiber**) that follows, tilts and
scales with your hand: a deep laceration with raw flesh walls, blood pooled
in it, swollen torn edges, wet blood oozing out with drips, a scrape, and
bruising around it.

## Run it

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` URL in Chrome, Edge, Firefox or
Safari and click **Start camera**. Camera access needs a secure context
(HTTPS or `localhost`). The hand model (~7.8 MB) and the MediaPipe WASM files
load from Google Storage and jsDelivr on first start, so you need internet
access.

Other scripts: `npm run build` (typecheck + production build into `dist/`),
`npm run preview`, `npm run typecheck`, `npm test` (unit tests, vitest).

### Testing without a camera

Add `?video=<path>` to the URL to play a looping video file instead of the
webcam (same-origin files only, since the frames must be readable). A sample
clip of an open palm moving is bundled: open
`/?video=samples/palm-moving.webm`, or click **No camera? Try the sample
video** on the start screen. See `public/samples/README.md` for its source
and licence.

**Debug** in the HUD shows the 21 landmarks and the palm mesh wireframe, plus
the frame-sync readout: the latest camera frame, the frame the wound pose and
the background were drawn from, and a count of renders where they differed.
The HUD always shows the render FPS and the mean detection time.

## Meta Quest 3 (mixed reality)

The AR experience (your real room through passthrough, with the wound on
your real palm, behaving like the webcam version) runs in the **Quest's own
browser**, using the headset's hand tracking:

1. In the headset, open **Browser** and go to
   `hanumantk.github.io/new-project`.
2. Tap **Start mixed reality**, then **Enter mixed reality**.
3. Put the controllers down and hold up your open palm.

To open it from the laptop over the USB cable instead of typing the address,
enable developer mode on the Quest and run (needs `adb`, e.g. from Meta Quest
Developer Hub):

```bash
adb shell am start -a android.intent.action.VIEW -d "https://hanumantk.github.io/new-project/" com.oculus.browser
```

**Quest Link (PC browser over the cable)** only supports VR, not
passthrough. The page says so, and offers a VR fallback with skin-toned
virtual hands in a simple room.

The wound goes on your right hand when it's tracked, otherwise the left; a
floating hint appears while no open hand is seen.

**Wound opacity in the headset:** a small panel floats below-left of where
you look when the session starts; press and slide along it with an index
fingertip. The headset page has the same slider (live over Quest Link), and
both remember the last value, as the webcam view's does.

The wound itself is the same as in the webcam view (curved palm mesh,
relief, cavity shading, wet-only gloss, feathered edges, angle fade, and the
fade when fingers cover most of it). What can't carry over to passthrough:
light and skin-tone matching and the camera-matching blur/grain need the
camera's pixels, which WebXR doesn't give a page, and the bruise is laid
over rather than multiplied, since passthrough is composited by the
headset.

## How it works

| Piece | File |
| --- | --- |
| Start screen / error screen, `?video=` test mode | `src/App.tsx` |
| Camera or test video, frame capture, detection loop, HUD stats | `src/components/ARView.tsx` |
| One canvas: background, wound, compositor (on-demand rendering) | `src/components/ARScene.tsx` |
| Captured frame as the full-screen background | `src/components/VideoBackground.tsx` |
| Lights from the skin, wound pass, camera-matching post pass | `src/components/WebcamCompositor.tsx` |
| Wound and bruise materials, angle fade, occlusion | `src/components/PalmInjury.tsx` |
| Palm-conforming 32×32 mesh with fixed palm-space UVs | `src/lib/palmMesh.ts` |
| One Euro filter for the landmarks | `src/lib/oneEuroFilter.ts` |
| Skin colour / camera noise sampling, and lighting from it | `src/lib/skinSampler.ts`, `src/lib/skinLighting.ts` |
| Procedural wound maps (colour, normals, height, roughness, masks), in a Web Worker | `src/lib/injury/` |
| Invisible hand that hides the wound behind it | `src/lib/handOccluder.ts` |
| Webcam landmarks → 3D hand pose, camera optics | `src/components/WebcamPoseSource.tsx` |
| Headset mode: session, VR room, hint panel | `src/components/XRView.tsx`, `src/components/XRScene.tsx` |
| Headset hand joints → the same 3D hand pose | `src/components/XRPoseSource.tsx` |
| HandLandmarker setup (VIDEO mode, 1 hand, confidence 0.6, GPU → CPU fallback) | `src/lib/handLandmarker.ts` |

- **One frame per render.** The `<video>` is only a frame source. Each new
  frame (`requestVideoFrameCallback`, falling back to `requestAnimationFrame`)
  is copied once into a canvas; detection runs on that copy, and the scene
  draws the same copy as its background before rendering once
  (`frameloop="demand"` + `invalidate()`). The wound pose and the picture
  behind it therefore always come from the same frame — no trailing.
- **Filtering.** No pose smoothing; instead each landmark coordinate goes
  through a One Euro filter (min cutoff 1 Hz, β 0.02, derivative cutoff
  1 Hz) in video pixels: steady when still, little lag when moving fast.
- **Alignment.** The canvas sits in a container mirrored with
  `transform: scaleX(-1)` (like a selfie camera); the background uses the
  same `object-fit: cover` maths the video element used, and the virtual
  camera has a webcam's field of view (~41° vertical) seen through that crop.
  Each landmark is placed along its pixel's camera ray, around a plane 0.5 m
  away, offset by MediaPipe's relative depth.
- **Curved wound.** A 32×32 grid is rebuilt every frame from landmarks 0, 1,
  5, 9, 13 and 17 (smooth curves along the wrist and knuckle rows, the heel
  mirrored from the thumb base), with their depth and a slight cup, so the
  wound bends and foreshortens with the palm. UVs are fixed in palm space,
  centred between landmarks 0 and 9. The displacement map runs on this mesh
  (×3) so the swollen rim bulges when the hand tilts. Palm normal =
  (5−0)×(17−0), flipped for left hands; the wound fades out between 55° and
  75° away from the camera.
- **On the skin.** Every few frames the skin in a ring around the wound is
  read from a small downscaled canvas; ambient and directional lights follow
  its brightness and colour, and the wound's skin-coloured parts take its
  tone. The bruise multiplies the picture (real skin shows through), the cut
  and wet blood are opaque, and every edge is feathered. The displacement
  depth darkens the cavity, and a contact shadow sits under the rim. Wet
  blood gets clearcoat 1.0 (from a blood mask); the rest is matte.
- **Camera matching.** The wound is rendered on its own and laid over the
  picture with a 0.7-camera-pixel blur, grain the size of a camera pixel at
  the measured noise level, and slightly lower saturation and contrast.
- **Occlusion.** An invisible stand-in for your hand (finger capsules plus the
  palm surface, pushed just behind the skin) writes depth only, so curled
  fingers or the back of the hand hide the wound. `src/lib/handOccluder.ts`.
- **Closed hand.** When the fingertips come in towards the wrist (openness
  below 1.15, back above 1.3) the wound fades out over 200 ms and the status
  pill says "Open your hand".
- **Performance.** Detection runs once per new camera frame; all per-frame
  maths reuses preallocated objects and buffers; per-frame data lives in refs
  (no React renders) and the HUD updates twice a second. **Stop** cancels the
  loop, closes the landmarker and stops the camera.

## Tuning

- `src/components/PalmInjury.tsx`: relief (`DISPLACEMENT_GAIN`), fade angles,
  skin matching, cavity darkening, bruise strength.
- `src/components/WebcamCompositor.tsx`: blur, saturation, contrast, grain
  bounds.
- `src/lib/palmMesh.ts`: wound size and placement in the palm, cup depth.
- `src/lib/oneEuroFilter.ts`: filter parameters.
- `src/lib/injury/generateInjury.ts`: the wound's colours and shapes.

## Known limits

- The hand stand-in is an approximation (finger capsules and the palm mesh),
  so the wound's cut-off edges follow your hand only roughly, and MediaPipe's
  depth estimate is noisy, so the palm's curvature can wobble a little.
- The palm mesh follows six landmarks and a fixed cup; it doesn't follow
  palm creases or fine skin folds.
- Light matching assumes the light falls on the palm roughly as it does on
  the reference skin tone; very coloured lighting is matched only halfway.
- The WASM URL uses `@latest` as specified; if a future MediaPipe release
  breaks compatibility with the installed npm package, pin the URL to the
  version in `package.json`.
