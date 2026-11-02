# Palm Injury AR: project and conversation context

Hand this file to a new Claude Code session, or to a collaborator, so they can carry on from where this conversation stopped (2 November 2026, after PR #49).

## 1. What the project is

**Palm Injury AR** shows a realistic special-effects wound on your palm in augmented reality, and teaches how that wound is made with makeup.

- Live site: https://hanumantk.github.io/new-project (GitHub Pages)
- Repository: https://github.com/Hanumantk/new-project (owner: Hanumantk)
- Stack: Vite, React and TypeScript, @react-three/fiber, three.js (r186), MediaPipe hand tracking (webcam mode), WebXR (headset mode), troika-three-text (headset text).

The app has two modes:

1. **Webcam mode** (desktop or phone browser): MediaPipe tracks the palm and the wound is drawn over the camera image. The user asked that this mode **not be touched** in recent work.
2. **Headset mode**, on Meta Quest 3, entered from the page in one of two ways:
   - **"Start mixed reality"** in the Quest Browser (passthrough): this is the main experience.
   - **"Use a VR headset"**: the VR fallback, offered only where mixed reality isn't supported. In this mode the material mat is deliberately **off**. The user does not want VR changed or turned into the main mode.

## 2. How to work on it

```bash
npm install
npx vite --port 5173        # dev server
npx tsc -b                  # TypeScript build (run before finishing any change)
npx vitest run              # unit tests
npx vite build              # production build
```

- **Deploy:** every merge to `main` runs the GitHub Pages workflow and publishes the site, which takes about a minute.
- **Workflow the user asked for ("sync after every change"):**
  1. Make the change on the branch `claude/relaxed-lovelace-eqqg8r`, then commit.
  2. Open a PR and merge it with the **merge** method.
  3. Wait for the Pages run to finish.
  4. Reset the branch to `origin/main` and force-push it.
- **Commits and PRs:** no AI model identifiers anywhere in them.
- **Credits are limited:** the user wants focused changes, no unrelated refactors, no new dependencies, and the TypeScript build run before finishing.
- **Local-only test file:** `src/lib/zzsim.test.ts` is excluded through `.git/info/exclude` and fails to run. It is not part of the repository; ignore it.
- **Emulator testing:** headset behaviour was tested in Meta's Immersive Web Emulator (IWER) driven by Playwright scripts. Those scripts lived in a scratch folder and are **not** in the repository.
  - To force the VR path, make `navigator.xr.isSessionSupported('immersive-ar')` return false, then click **"Use a VR headset"** and **"Enter VR"**.
  - `?test` in the URL makes the **T** key trace a test mat rectangle.
  - In development builds these debug handles exist on `window`: `__xrWound`, `__buddy`, `__mat`.

## 3. Map of the headset code

| Area | Files |
|---|---|
| Scene wiring (wound, Buddy, panels, mat, grab) | `src/components/XRScene.tsx`, `XRView.tsx` (session entry and in-page notes) |
| Wound on the palm | `src/components/XRWound.tsx`, `src/lib/xrWoundConform.ts`, `woundGeometry.ts`, `xrWoundMaterial.ts`, `xrHandModel.ts` |
| "How it's made" stage flow | `src/lib/woundSteps.ts` (`StageFlow`, labels, the shared `woundLink`) and the stage looks in `xrWoundMaterial.ts` |
| Buddy companion | `src/components/XRBuddy.tsx`, `src/lib/buddy.ts` (placement rules, faces, growth), `buddyMotion.ts` (how it moves), `xrSpeechBubble.ts`, `public/models/buddy_character.glb` |
| Wound controls panel (hand, skin tone, Calibrate, Mesh, Tone and Height sliders) | `src/components/XRWoundPanel.tsx`, `src/lib/xrPrefs.ts` |
| Wound opacity slider panel | `HeadsetSlider` inside `XRScene.tsx` |
| Material mat and its control panel (Prev/Next, Step mode, Redraw, Opacity) | `src/mat/MaterialMat.tsx`, `src/mat/xr/MatSystem.ts`, `ControlPanel.ts`, `src/mat/lib/*` |
| Carrying things with a fist | `src/lib/grab.ts` (`GrabSystem`, `PANEL_GRAB_TINT`), `src/components/GrabController.tsx` |
| Touch feedback | `src/lib/pokeSlider.ts` (`SliderGrip`), `fingerCursor.ts`, `uiSound.ts` |
| Pinch detection (shared) | `src/mat/lib/pinch.ts` (`PinchDetector`, thresholds configurable) |

## 4. Current behaviour (as of PR #49)

### The wound

- **Hand model:** a sculpted Blender hand model (`public/models/Hand.glb`), exported at full detail and scaled uniformly to the user's hand, is posed on the chosen hand's joints every frame.
- **Attachment:** the wound (`Wound.glb`, 8.5 cm long, turned 35° toward the thumb) is laid onto the model's palm skin and skinned to the model's bones, so it moves and bends with the palm.
- **Occlusion:** the model is drawn depth-only, so the real hand hides the wound when it should.
- **Which hand:** the wound hand defaults to **left** (`xrPrefs.hand`) and can be changed on the wound panel.
- **Skin tone:** comes from the camera (Auto) or from presets, with fine Tone and Height sliders on the wound panel.

### "How it's made" step flow (`woundSteps.ts`)

- **Gesture:** a pinch of the **other** hand within 12 cm of the wound steps the flow on release. The order is finished wound → 1 → … → 6 → finished wound. It only goes **forward**; pinch-and-hold to go back was removed at the user's request.
- **Pinch detection:**
  - Starts below 2 cm and ends above 3 cm, measured between the thumb and index tip joints.
  - Survives the hand being hidden for up to 1 s.
  - Counts if it comes within range at any point while held.
  - A 0.25 s cooldown after each step.
- **Near miss:** a quick pinch (under 1 s) within 30 cm of the wound but never within 12 cm counts as a near miss, and Buddy asks for a closer one.
- **One mesh, all stages:** every stage is the **same wound mesh**. Its shape is blended in the vertex shader before skinning (bare skin, wax mound, or the sculpted wound), so each stage sits exactly where the wound is.
- **The stages:**
  1. spirit gum film with a dashed guide outline
  2. wax mound
  3. cut sculpted, powdered pinkish-grey
  4. coloured: raw red cut, bruise
  5. blood, identical to the finished wound
  6. aged: darker edges and cut, drier blood (measured from `Stage_6.glb`'s textures)
- **Labels:** the stage instructions live in `STAGE_LABELS`, and Buddy speaks them.
- **Ring:** a small ring at the wound shows when a pinch would count, turning mint while pinching.

### Buddy (`XRBuddy.tsx`, `buddy.ts`, `buddyMotion.ts`)

- **Size and colour:** 8 cm wide (`BUDDY_SIZE_CM`), body colour `BUDDY_COLOR` `#EC6A67`.
- **Home (placement rules):**
  - Beside the wound hand on the thumb side: 12 cm out, 4 cm up, 3 cm toward the eyes.
  - Never within 12° of the wound as seen from the eyes, never within 8 cm of the palm, and kept inside a 25° view cone.
- **Working:** once a step is shown and the hand has been still for 0.6 s, Buddy parks **20 cm to the hand's left** (as you see it) and stays there. The lock lifts when the hand moves more than 10 cm (it parks again once the hand is still) or when the flow ends. During steps it never flies over to the wound; it nods where it is.
- **No hand:** Buddy parks **60 cm away, 18° to the wound hand's side, slightly low**. It stays locked in the room (it doesn't follow the head) until it would leave the view, then parks again beside the new view. After 8 s it dozes, only sinking 5 cm and never coming closer.
- **Motion:**
  - It stays put while home moves within 6 cm and it's in view. Otherwise it reacts after 0.25–0.5 s and flies there with steering (0.6 m/s, 1.5 m/s²) along an arc bent around the palm and the eyes.
  - Long trips start with a small dip. In flight it leans and banks, faces its direction of travel, and stretches.
  - On arrival it overshoots a little, bobs, squashes and settles.
  - At rest it drifts on smooth noise and glances at the hand. Every 20–40 s, when nothing else is happening, it does a loop or a hop (not while working).
- **Facing:** whenever Buddy is showing an expression (a reaction, talking, a clip, curiosity at a coming pinch), it faces the viewer's eyes.
- **Animations:**
  - Idle_Float at weight 0.6 is the only continuous clip. While flying, Excited blends in with speed.
  - Occasions: Wave on hello, Excited when the flow starts, Nod_Yes per step, Shake_No for a near miss, and at the end Happy_Bounce ×2 (after a lap round the hand, unless the user was working). Sleepy plays when the hand is lost for 8 s; when it returns, Buddy looks surprised and zips back.
- **Faces and growth:** faces come from a 4×4 atlas, with talking while text types and random blinks. The sprout grows with the stages.
- **Speech bubble:** Buddy's bubble replaced the old floating stage label.
  - Text types out at 35 characters per second, with progress dots and a tail pointing at Buddy.
  - The bubble sits on the side away from the wound, follows Buddy on a spring, and dims during long flights.
  - New text waits until Buddy has arrived.
- **Safety:** an error in Buddy hides Buddy; it can never stop the wound. Its environment map is built once at mount, before any session.

### Panels and touch

- **Fist carry:** the material mat, its control panel, the wound opacity panel and the wound controls panel can all be moved: hand on it (or point at it), make a fist, move, open the hand. Panel positions last only for the session; the mat's position is saved with its anchor.
- **Sliders** (wound opacity, Tone, Height, mat opacity):
  - A fingertip within 6 cm glows the track and grows the knob. A touch grabs the slider and the knob fills green.
  - Once grabbed, only sideways movement counts. It survives drifting up to 5 cm up or down, 6 cm in front of or 5 cm behind the face, and up to 0.25 s of lost tracking. It lets go only when the finger is pulled away.
- **Cursor:** every panel shows a fingertip cursor ring, which turns green on contact.
- **Wound panel buttons:** a green outline on hover and a green flash when pressed.
- **Sounds:** a click on press or grab, ticks while sliding, a lower click on release (WebAudio, no files).
- **Mat controls toggle:** holding the palm **without** the wound face-up for 0.5 s hides or shows the mat controls. The wound's own palm never toggles them.

## 5. Constants the user may want to tune

| What | Constant | File | Value |
|---|---|---|---|
| Stage pinch thresholds | `STAGE_PINCH_START` / `STAGE_PINCH_END` | `woundSteps.ts` | 2 cm / 3 cm |
| Pinch range | `PINCH_RANGE` | `woundSteps.ts` | 12 cm |
| Near miss range | `MISS_RANGE` | `woundSteps.ts` | 30 cm |
| Pinch grace while the hand is hidden | `STAGE_PINCH_GRACE` | `woundSteps.ts` | 1 s |
| Stage transitions | `TRANSITION_SECONDS`, `CUT_OPEN_SECONDS` | `woundSteps.ts` | 0.4 s, 0.8 s (cut opening) |
| Stage 6 look | `agedLips`, `agedCut`, `agedDry` in `XR_WOUND_LOOK` | `xrWoundMaterial.ts` | measured from `Stage_6.glb` |
| Buddy size and colour | `BUDDY_SIZE_CM`, `BUDDY_COLOR` | `buddy.ts` | 8 cm, `#EC6A67` |
| Buddy beside the hand | `BUDDY_SIDE`, `BUDDY_UP`, `BUDDY_TOWARD_EYE` | `buddy.ts` | 12 / 4 / 3 cm |
| View cone, no-block angle | `VIEW_CONE_DEG`, `NO_BLOCK_DEG` | `buddy.ts` | 25°, 12° |
| Parking while working | `WORK_SIDE`, `STILL_SECONDS`, `STILL_SPEED`, `UNLOCK_MOVE` | `buddy.ts` | 20 cm, 0.6 s, 4 cm/s, 10 cm |
| Parking with no hand | `AWAY_DISTANCE`, `AWAY_SIDE_DEG`, `AWAY_BELOW`, `AWAY_RELOCK_DEG` | `buddy.ts` | 60 cm, 18°, 4 cm, 24° |
| Comfort zone and reaction | `COMFORT_ZONE_CM`, `REACTION_DELAY_S` | `buddyMotion.ts` | 6 cm, 0.25–0.5 s |
| Flight | `MAX_SPEED`, `MAX_ACCEL`, `ZIP_SPEED`, `ARC_HEIGHT` | `buddyMotion.ts` | 0.6 m/s, 1.5 m/s², 1 m/s, 3–6 cm |
| Body language | `LEAN_MAX_DEG`, `ROLL_MAX_DEG`, `SQUASH_AMOUNT`, `STRETCH_AMOUNT` | `buddyMotion.ts` | 20°, 15°, 5%, 6% |
| Idle life | `DRIFT_CM`, `DRIFT_DEG`, `GLANCE_INTERVAL_S`, `FLOURISH_INTERVAL_S` | `buddyMotion.ts` | 1.2 cm, 4°, 4–9 s, 20–40 s |
| Buddy's lines, sleep delay, idle weight, flapping | `BUDDY_LINES`, `SLEEP_AFTER`, `IDLE_WEIGHT`, `FLAP_WEIGHT` | `XRBuddy.tsx` | 8 s, 0.6, 0.7 |
| Bubble text | `TEXT_SPEED`, `BUBBLE_TEXT_SIZE`, `BUBBLE_MAX_WIDTH` | `xrSpeechBubble.ts` | 35 characters/s, 1.35 cm, 14 cm |
| Slider capture | `SLIDER_HOVER_DEPTH`, `SLIDER_CAPTURE`, `SLIDER_LOST_GRACE` | `pokeSlider.ts` | 6 cm, see the file, 0.25 s |

## 6. History (merged PRs, in order)

- **#1–#3:** GitHub Pages deploy; the cube was replaced by a realistic palm wound (webcam mode).
- **#4–#6:** Meta Quest headset mode: VR over Quest Link, then mixed reality in the Quest Browser as the lead option.
- **#7–#11:** camera-free testing (`?video`), opacity slider, hiding the wound when fingers cover it, the same features in the headset, and Mesh view.
- **#12–#15:** the material mat (pinch-trace a rectangle on the table and the kit is laid out on it), moved into mixed reality; carrying things with a fist.
- **#16–#23:** webcam palm pose refinements; headset wound look (material, skin tone, lighting, 8.5 cm, shading).
- **#24–#28:** the wound fixed to a posed hand model, sized to the user's hand, and finally the project's sculpted Blender hand at full detail (#28 became the user's chosen baseline).
- **#29–#32:** an Apple-style glass UI, a Figma "Liquid Glass" kit UI (reverted in #31) and contrast fixes. **#35 reverted all the glass UI**; the user prefers the original design.
- **#33–#37:** a first version of the build stages (separate stage models) and a first Buddy, plus a headset freeze fix. **All of it was reverted by #38**, back to #28, at the user's request.
- **#39:** the stage flow rebuilt as one mesh with five states, driven by a shader.
- **#40:** stage 6 (the aged wound).
- **#41:** forward-only flow; much more reliable pinch detection.
- **#42:** Buddy rebuilt: speaks the flow in a speech bubble, with animations only on occasions.
- **#43:** Buddy moves like a creature (decide, fly an arc, lean, overshoot, settle, drift, glance, flourishes, a move per occasion).
- **#44:** Buddy faces the viewer whenever it shows an expression.
- **#45:** fix: the mat controls were hidden by turning the wound's (left) palm up; the toggle now uses the other palm.
- **#46:** the wound controls panel can be carried with a fist.
- **#47:** Buddy keeps out of the way while you work (parks left, no visits to the wound).
- **#48:** touch feedback everywhere, and sliders you can't lose.
- **#49:** without the hand, Buddy waits off to the side at a distance (not in your face); fixed a stale waiting spot.

## 7. User preferences learned in this conversation

- Keep the original light UI; no glass or liquid-glass styling.
- Headset work targets **mixed reality on Quest 3**. Don't convert features to VR unless asked.
- Don't touch the webcam mode when working on the headset.
- Buddy should be calm and out of the way while the user works: never come near the hand during steps, and never float in front of the face.
- Every interaction should give clear feedback; sliders must not be lost mid-slide.
- Explain changes in plain language, then list what to test in the headset and which constants to tune.

## 8. Open items and ideas mentioned but not done

- Buddy's speech bubble draws over everything, so Buddy and its bubble can float in front of a panel and hide it. Offered to make Buddy keep clear of panels.
- Remembering where the wound panels were moved across sessions (only the mat remembers its place today). Offered, not built.
- On its way to the parked spot, Buddy crosses past the hand once, arcing over it at about 11 cm.
- None of the headset behaviour has been confirmed on a real Quest by Claude; all checks ran in the emulator, which renders at about 5–6 fps, so frame rate couldn't be measured. The user tests on their own Quest 3.

## 9. Other questions answered

- **Casting the Quest view to a laptop:** on the laptop, open Chrome or Edge at oculus.com/casting, signed in with the same Meta account and on the same Wi-Fi as the headset. In the headset, choose Camera → Cast → Computer.
  - Availability in India isn't confirmed by Meta; the Quest 3 isn't officially sold there.
  - Fallbacks that work anywhere: the Meta Horizon Link app on Windows, scrcpy over USB with Developer Mode, or recording in the headset.
- **Letting someone else's Claude Code change the repository:**
  - Add them as a collaborator (Settings → Collaborators), or let them fork and send pull requests.
  - Claude Code on the web also needs the Claude GitHub app installed for the repository.
  - Turn on branch protection for `main` so changes come as pull requests to review, because every merge to `main` publishes the site.
