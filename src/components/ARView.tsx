import { useCallback, useEffect, useRef, useState } from 'react';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import { createHandLandmarker, type Delegate } from '../lib/handLandmarker';
import { computeCover, createCoverRect } from '../lib/coverMapping';
import { drawLandmarks } from '../lib/drawLandmarks';
import { CLOSED_HAND_SCORE, OPEN_HAND_SCORE } from '../lib/handPose';
import { LandmarkFilter } from '../lib/oneEuroFilter';
import { SkinSampler } from '../lib/skinSampler';
import { loadWoundOpacity, saveWoundOpacity } from '../lib/woundOpacity';
import { createTrackingState, handOpenness, type TrackingState } from '../lib/tracking';
import { WebcamPalmTracker } from '../lib/webcamPalm';
import { ARScene } from './ARScene';
import { ALL_DEBUG_LAYERS, Hud, type DebugLayers, type HandStatus, type HudStats } from './Hud';

/** Frames a new handedness label must persist before we believe it. */
const HANDEDNESS_HYSTERESIS = 5;
const STATS_UPDATE_MS = 500;
/** Sample the skin's colour every this many frames. */
const SKIN_SAMPLE_EVERY = 3;
/** A hand lost for less than this (ms) keeps its last pose rather than vanishing. */
const DROPOUT_HOLD_MS = 150;
/** After the hand has been out of view this long, its palm shape is captured again. */
const RECAPTURE_AFTER_MS = 1000;

const UNSUPPORTED_MESSAGE =
  'This browser can’t access a camera here. Open the page over HTTPS (or localhost) in a recent Chrome, Edge, Firefox or Safari.';

type Phase = 'camera' | 'model' | 'running';

interface ARViewProps {
  onError: (message: string) => void;
  onStop: () => void;
  /**
   * Play this (same-origin) video file in a loop instead of using the
   * webcam, for testing without a camera (`?video=<path>`).
   */
  sampleVideo?: string | null;
}

export function ARView({ onError, onStop, sampleVideo = null }: ARViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const debugCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackingRef = useRef<TrackingState>(createTrackingState());
  const debugRef = useRef(false);
  const invalidateRef = useRef<(() => void) | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [phase, setPhase] = useState<Phase>('camera');
  const [handStatus, setHandStatus] = useState<HandStatus>('none');
  const [stats, setStats] = useState<HudStats | null>(null);
  const [delegate, setDelegate] = useState<Delegate | null>(null);
  const [debug, setDebug] = useState(false);
  const [debugLayers, setDebugLayers] = useState<DebugLayers>(ALL_DEBUG_LAYERS);
  const showLandmarks = debug && debugLayers.landmarks;
  const [woundOpacity, setWoundOpacity] = useState(loadWoundOpacity);
  const [view, setView] = useState<'camera' | 'mesh'>('camera');
  useEffect(() => invalidateRef.current?.(), [view]);
  const woundOpacityRef = useRef(woundOpacity);

  // The scene reads the opacity from a ref; redraw so a change shows at once.
  useEffect(() => {
    woundOpacityRef.current = woundOpacity;
    invalidateRef.current?.();
    saveWoundOpacity(woundOpacity);
  }, [woundOpacity]);

  useEffect(() => {
    debugRef.current = showLandmarks;
    invalidateRef.current?.();
    if (!showLandmarks) {
      const canvas = debugCanvasRef.current;
      canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [showLandmarks]);
  useEffect(() => invalidateRef.current?.(), [debug, debugLayers]);

  useEffect(() => {
    const video = videoRef.current!;
    const stage = stageRef.current!;
    const debugCanvas = debugCanvasRef.current!;
    const debugCtx = debugCanvas.getContext('2d')!;
    const tracking = trackingRef.current;
    // Development only: lets test scripts read the tracking state.
    if (import.meta.env.DEV) (window as unknown as { __tracking?: TrackingState }).__tracking = tracking;

    // Each camera frame is copied here once; detection and the scene's
    // background both use this copy, so they always agree on the frame.
    const capture = document.createElement('canvas');
    const captureCtx = capture.getContext('2d', { alpha: false })!;
    // Small squares of the frame, read back for following the skin by optical flow.
    const patch = document.createElement('canvas');
    const patchCtx = patch.getContext('2d', { alpha: false, willReadFrequently: true })!;
    const readPatch = (x0: number, y0: number, size: number, out: Float32Array) => {
      if (patch.width !== size) patch.width = patch.height = size;
      patchCtx.fillStyle = '#000';
      patchCtx.fillRect(0, 0, size, size);
      patchCtx.drawImage(capture, x0, y0, size, size, 0, 0, size, size);
      const rgba = patchCtx.getImageData(0, 0, size, size).data;
      for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
      return true;
    };
    tracking.frame = capture;
    const landmarkFilter = new LandmarkFilter();
    const palmTracker = new WebcamPalmTracker();
    if (import.meta.env.DEV) (window as unknown as { __palmTracker?: WebcamPalmTracker }).__palmTracker = palmTracker;
    const skinSampler = new SkinSampler();

    let cancelled = false;
    let rafId = 0;
    let videoFrameHandle = 0;
    let watchdog = 0;
    let stream: MediaStream | null = null;
    let landmarker: HandLandmarker | null = null;

    // Keep the debug canvas at the stage's size (in device pixels).
    const view = { width: 0, height: 0, dpr: 1 };
    const resize = () => {
      const rect = stage.getBoundingClientRect();
      view.width = rect.width;
      view.height = rect.height;
      view.dpr = Math.min(window.devicePixelRatio || 1, 2);
      debugCanvas.width = Math.round(view.width * view.dpr);
      debugCanvas.height = Math.round(view.height * view.dpr);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    resize();

    const cover = createCoverRect();
    let lastVideoTime = -1;
    let lastTimestamp = 0;
    let handPresent = false;
    let lastSeen = -Infinity;
    let lastMediaTime = -Infinity;
    let status: HandStatus = 'none';
    let handednessVotes = 0;
    let detectTotal = 0;
    let detectCount = 0;
    let debugDirty = false;
    let videoFramesSeen = 0;

    /**
     * Captures the current video frame, detects on it and requests one render.
     * @param now when the frame is presented (ms), for detection's timestamps.
     * @param mediaTime when the frame was captured (s): the pose filters run on
     *   this clock, so their timing matches the hand's real motion even if a
     *   frame is processed late.
     */
    const processFrame = (now: number, mediaTime: number) => {
      if (!landmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) {
        return;
      }
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (capture.width !== width || capture.height !== height) {
        capture.width = width;
        capture.height = height;
      }
      captureCtx.drawImage(video, 0, 0, width, height);

      const timestamp = Math.max(now, lastTimestamp + 1); // must strictly increase
      lastTimestamp = timestamp;
      const detectStart = performance.now();
      const result = landmarker.detectForVideo(capture, timestamp);
      detectTotal += performance.now() - detectStart;
      detectCount++;

      const raw = result.landmarks[0] ?? null;
      const rawWorld = result.worldLandmarks[0] ?? null;
      // A jump back in time (a looping test clip) is a cut, not motion.
      if (mediaTime < lastMediaTime) palmTracker.lose();
      lastMediaTime = mediaTime;
      tracking.mediaTime = mediaTime;

      // Brief dropout (a blurred frame, a missed detection): hold the last
      // pose and show this frame with it, rather than flashing the wound off.
      if (!raw && handPresent && now - lastSeen < DROPOUT_HOLD_MS) {
        tracking.frameId++;
        invalidateRef.current?.();
        return;
      }

      if (raw) {
        // We feed raw (unmirrored) camera frames; for those the label matches
        // the user's actual hand (verified against a known right-hand photo).
        const isRightHand = result.handedness[0]?.[0]?.categoryName === 'Right';
        if (!handPresent) {
          tracking.isRightHand = isRightHand;
          handednessVotes = 0;
        } else if (isRightHand !== tracking.isRightHand) {
          if (++handednessVotes >= HANDEDNESS_HYSTERESIS) {
            tracking.isRightHand = isRightHand;
            handednessVotes = 0;
            landmarkFilter.reset(); // a different hand: don't blend between them
            palmTracker.lose();
          }
        } else {
          handednessVotes = 0;
        }
      } else {
        landmarkFilter.reset();
        palmTracker.lose();
        // Gone for a while: capture the palm's shape afresh when it's back.
        if (now - lastSeen > RECAPTURE_AFTER_MS) palmTracker.template.reset();
      }
      const landmarks = raw ? landmarkFilter.filter(raw, timestamp / 1000, width, height) : null;

      // The wound's anchor: the palm as a rigid body, fitted to the raw
      // landmarks and filtered as a whole (never per landmark).
      const palmValid =
        raw !== null &&
        rawWorld !== null &&
        palmTracker.update(raw, rawWorld, width, height, tracking.isRightHand, mediaTime, readPatch);
      if (palmValid) {
        const pose = palmTracker.pose;
        const palm = tracking.palm;
        palm.position.copy(pose.position);
        palm.quaternion.copy(pose.quaternion);
        palm.template.set(pose.template);
        palm.templateVersion = pose.templateVersion;
        palmTracker.joints(landmarks!, rawWorld!, tracking.joints);
        tracking.jitter.px = palmTracker.jitter.rms;
        tracking.jitter.rawPx = palmTracker.rawJitter.rms;
        tracking.jitter.speed = palmTracker.rawJitter.speed;
      }
      tracking.palm.valid = palmValid;
      if (raw) lastSeen = now;
      if (landmarks) {
        const openness = handOpenness(landmarks, width, height);
        tracking.handOpen = openness > (tracking.handOpen ? CLOSED_HAND_SCORE : OPEN_HAND_SCORE);
      } else {
        tracking.handOpen = false;
      }
      tracking.landmarks = landmarks;
      tracking.frameId++;
      handPresent = landmarks !== null;

      // Light matching: read the skin around the wound every few frames
      // (lighting changes slowly; the reading is smoothed anyway).
      if (landmarks && tracking.frameId % SKIN_SAMPLE_EVERY === 0) {
        skinSampler.update(video, width, height, landmarks, tracking.skin);
      }

      // Draw this frame (background + wound) together, once.
      invalidateRef.current?.();

      const nextStatus: HandStatus = !handPresent ? 'none' : tracking.handOpen ? 'open' : 'closed';
      if (nextStatus !== status) {
        status = nextStatus;
        setHandStatus(nextStatus);
      }

      if (debugRef.current && view.width > 0) {
        debugCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        debugCtx.clearRect(0, 0, view.width, view.height);
        if (landmarks) {
          computeCover(cover, view.width, view.height, width, height);
          drawLandmarks(debugCtx, landmarks, cover);
        }
        debugDirty = true;
      } else if (debugDirty) {
        debugCtx.setTransform(1, 0, 0, 1, 0, 0);
        debugCtx.clearRect(0, 0, debugCanvas.width, debugCanvas.height);
        debugDirty = false;
      }
    };

    // HUD numbers: average detection time and render rate over the last window.
    let statsRenders = tracking.rendered.renders;
    let statsAt = performance.now();
    const statsTimer = window.setInterval(() => {
      const at = performance.now();
      const renders = tracking.rendered.renders;
      const { poseFrameId, backgroundFrameId, mismatches } = tracking.rendered;
      setStats({
        renderFps: ((renders - statsRenders) * 1000) / (at - statsAt),
        detectMs: detectCount ? detectTotal / detectCount : null,
        frameId: tracking.frameId,
        poseFrameId,
        backgroundFrameId,
        mismatches,
        ...jitterReading(tracking),
      });
      statsRenders = renders;
      statsAt = at;
      detectTotal = 0;
      detectCount = 0;
    }, STATS_UPDATE_MS);

    // Preferred: run exactly once per new video frame, as it is presented.
    const onVideoFrame: VideoFrameRequestCallback = (now, metadata) => {
      videoFrameHandle = video.requestVideoFrameCallback(onVideoFrame);
      videoFramesSeen++;
      processFrame(now, metadata.mediaTime);
    };
    // Fallback: poll on animation frames and skip repeats.
    const onAnimationFrame = (now: number) => {
      rafId = requestAnimationFrame(onAnimationFrame);
      if (video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;
      processFrame(now, video.currentTime);
    };
    const startLoop = () => {
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
        videoFrameHandle = video.requestVideoFrameCallback(onVideoFrame);
        // Some browsers don't deliver frame callbacks for a video that isn't
        // shown; if none arrive, fall back to animation frames.
        watchdog = window.setTimeout(() => {
          if (cancelled || videoFramesSeen > 0) return;
          console.warn('No video frame callbacks; falling back to requestAnimationFrame.');
          video.cancelVideoFrameCallback(videoFrameHandle);
          rafId = requestAnimationFrame(onAnimationFrame);
        }, 1500);
      } else {
        rafId = requestAnimationFrame(onAnimationFrame);
      }
    };

    const startSampleVideo = async (url: string) => {
      video.src = url;
      video.loop = true;
      try {
        await video.play();
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          onErrorRef.current(`Couldn’t play the sample video (${url}).`);
        }
        return false;
      }
      return !cancelled;
    };

    const startCamera = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        onErrorRef.current(UNSUPPORTED_MESSAGE);
        return false;
      }

      let mediaStream: MediaStream;
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 60 },
            facingMode: 'user',
          },
          audio: false,
        });
      } catch (err) {
        if (!cancelled) onErrorRef.current(cameraErrorMessage(err));
        return false;
      }
      if (cancelled) {
        stopStream(mediaStream);
        return false;
      }
      stream = mediaStream;
      video.srcObject = mediaStream;
      try {
        await video.play();
      } catch {
        // play() rejects if we unmount mid-start; autoplay attribute covers the rest.
      }
      return !cancelled;
    };

    const start = async () => {
      const started = sampleVideo ? await startSampleVideo(sampleVideo) : await startCamera();
      if (!started) return;

      setPhase('model');
      let loaded;
      try {
        loaded = await createHandLandmarker();
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          onErrorRef.current(
            'Couldn’t load the hand-tracking model. Check your internet connection and try again.',
          );
        }
        return;
      }
      if (cancelled) {
        loaded.landmarker.close();
        return;
      }
      landmarker = loaded.landmarker;
      setDelegate(loaded.delegate);
      setPhase('running');
      startLoop();
    };

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      window.clearInterval(statsTimer);
      window.clearTimeout(watchdog);
      if ('cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(videoFrameHandle);
      resizeObserver.disconnect();
      landmarker?.close();
      landmarker = null;
      if (stream) stopStream(stream);
      video.srcObject = null;
      video.removeAttribute('src');
      video.load();
      tracking.landmarks = null;
      tracking.handOpen = false;
      tracking.frame = null;
    };
  }, []);

  const onSceneReady = useCallback((invalidate: () => void) => {
    invalidateRef.current = invalidate;
  }, []);

  return (
    <div className="ar-root">
      {/* Everything in the stage is mirrored together, like a selfie camera. */}
      <div className="stage" ref={stageRef}>
        {/* Only a frame source: the scene draws the frames it detected on. */}
        <video ref={videoRef} className="layer video source-video" autoPlay playsInline muted />
        <div className="layer">
          <ARScene
            tracking={trackingRef}
            onReady={onSceneReady}
            debug={debug}
            debugSurface={debug && debugLayers.surface}
            debugBox={debug && debugLayers.box}
            woundOpacity={woundOpacityRef}
            view={view}
          />
        </div>
        <canvas ref={debugCanvasRef} className="layer debug" />
      </div>

      <Hud
        handStatus={handStatus}
        stats={phase === 'running' ? stats : null}
        delegate={delegate}
        source={sampleVideo ? 'Sample video' : null}
        debug={debug}
        onToggleDebug={() => setDebug((v) => !v)}
        debugLayers={debugLayers}
        onToggleDebugLayer={(layer) => setDebugLayers((l) => ({ ...l, [layer]: !l[layer] }))}
        woundOpacity={woundOpacity}
        onWoundOpacityChange={setWoundOpacity}
        view={view}
        onViewChange={setView}
        onStop={onStop}
      />

      {phase !== 'running' && (
        <div className="loading panel">
          <span className="spinner" aria-hidden />
          {phase === 'camera' ? 'Starting camera…' : 'Loading hand model…'}
        </div>
      )}
    </div>
  );
}

function stopStream(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'Camera access was blocked. To try the demo, allow camera access for this site (usually via the camera icon in the address bar), then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'We couldn’t find a camera. Plug one in or enable your built-in webcam, then try again.';
    case 'NotSupportedError':
      return UNSUPPORTED_MESSAGE;
    case 'NotReadableError':
    case 'AbortError':
      return 'Your camera seems to be busy in another app or tab. Close it there, then try again.';
    default:
      return 'Something went wrong while starting the camera. Please try again.';
  }
}

/** Faster than this (video px/s), the hand counts as moving and jitter isn't meaningful. */
const STILL_SPEED_PX = 40;

function jitterReading(tracking: TrackingState): Pick<HudStats, 'jitterPx' | 'rawJitterPx'> {
  const { px, rawPx, speed } = tracking.jitter;
  if (!tracking.palm.valid || px === 0 || speed > STILL_SPEED_PX) return { jitterPx: null, rawJitterPx: null };
  return { jitterPx: px, rawJitterPx: rawPx };
}
