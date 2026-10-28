# Palm cube — AR hand-tracking prototype

A single-page React + TypeScript app that uses your webcam, tracks your hand in
real time with MediaPipe's **HandLandmarker**, and places a rounded mint-green
3D cube (three.js via **@react-three/fiber**) on your palm that follows,
tilts and scales with your hand.

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
`npm run preview`, `npm run typecheck`.

## How it works

| Piece | File |
| --- | --- |
| Start screen / error screen | `src/App.tsx` |
| Camera, detection loop, landmark debug overlay, cleanup | `src/components/ARView.tsx` |
| Transparent R3F canvas + lights | `src/components/ARScene.tsx` |
| Cube placement, rotation, scale, smoothing, fade | `src/components/PalmCube.tsx` |
| Invisible hand that hides the cube behind it | `src/lib/handOccluder.ts` |
| HandLandmarker setup (VIDEO mode, 1 hand, GPU → CPU fallback) | `src/lib/handLandmarker.ts` |
| `object-fit: cover` maths shared by 2D and 3D overlays | `src/lib/coverMapping.ts` |

- **Alignment.** The video, the 3D canvas and the landmark canvas sit in one
  container mirrored with `transform: scaleX(-1)`, so all three flip together.
  Landmarks are mapped through the same cover-crop rectangle the browser uses
  for the video, and the virtual camera's field of view is set to a typical
  webcam's (~41° vertical) seen through that crop, so the cube's perspective
  matches the image.
- **Position.** Each landmark is mapped through the cover crop to a view pixel
  and placed along that pixel's camera ray, around a plane 0.5 m in front of
  the camera (offset by MediaPipe's relative depth). Palm centre = mean of
  landmarks 0, 5, 9, 13, 17. The cube (6 cm)
  sits just above the palm along the palm normal, with a soft shadow blob on
  the palm.
- **Scale.** The wrist → middle-knuckle (0 → 9) length, measured on that plane
  and divided by a typical 9 cm palm, so the cube grows as your hand comes closer.
- **Rotation.** Basis from 0 → 9 (towards the fingers) and 5 → 17 (across the
  palm); their cross product is the palm normal, flipped for left hands so the
  cube always sits on the palm side.
- **Occlusion.** An invisible 3D stand-in for your hand (finger capsules
  plus a palm plate, built from all 21 landmarks) writes depth but no colour,
  so the real hand hides whatever part of the cube is behind it: from the
  back of the hand the cube is hidden (except where it would really peek
  between fingers or past the edge), from the side the part sticking out of
  the palm stays visible. `src/lib/handOccluder.ts`.
- **Closed hand.** A closed hand has no palm to rest on: when the fingertips
  come in towards the wrist (openness below 1.15, back above 1.3) the cube
  fades out and the status pill says "Open your hand".
- **Smoothing / fade.** Position, rotation and scale are lerped/slerped with
  factor 0.35 each frame; the cube fades out over 200 ms when the hand is lost
  and snaps back in place before fading in when it returns.
- **Performance.** Inference only runs when the camera has delivered a new
  frame; all per-frame maths reuses preallocated vectors; per-frame data
  lives in a ref (no React renders), and the HUD updates FPS twice a second.
  Unmounting (or **Stop camera**) cancels the loop, closes the landmarker and
  stops the camera tracks.

## Tuning

Constants at the top of `src/components/PalmCube.tsx`: `CUBE_SIZE`,
`HOVER_GAP`, `REAL_PALM_LENGTH`, `WEBCAM_VFOV_DEG`, `SMOOTHING`,
`FADE_SECONDS`.

## Known limits

- The hand stand-in is an approximation (capsules and a flat palm), so the
  cube's cut-off edges follow your hand only roughly, and MediaPipe's depth
  estimate is noisy, so how much peeks out from behind the hand can wobble.
- The WASM URL uses `@latest` as specified; if a future MediaPipe release
  breaks compatibility with the installed npm package, pin the URL to the
  version in `package.json`.
