import { useCallback, useEffect, useRef, useState } from 'react';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import { createHandLandmarker, type Delegate } from '../lib/handLandmarker';
import { computeCover, createCoverRect } from '../lib/coverMapping';
import { drawLandmarks } from '../lib/drawLandmarks';
import { CLOSED_HAND_SCORE, OPEN_HAND_SCORE } from '../lib/handPose';
import { LandmarkFilter } from '../lib/oneEuroFilter';
import { SkinSampler } from '../lib/skinSampler';
import { createTrackingState, handOpenness, type TrackingState } from '../lib/tracking';
import { ARScene } from './ARScene';
import { Hud, type HandStatus } from './Hud';

/** Frames a new handedness label must persist before we believe it. */
const HANDEDNESS_HYSTERESIS = 5;
const FPS_UPDATE_MS = 500;
/** Sample the skin's colour every this many frames. */
const SKIN_SAMPLE_EVERY = 3;

const UNSUPPORTED_MESSAGE =
  'This browser can’t access a camera here. Open the page over HTTPS (or localhost) in a recent Chrome, Edge, Firefox or Safari.';

type Phase = 'camera' | 'model' | 'running';

interface ARViewProps {
  onError: (message: string) => void;
  onStop: () => void;
}

export function ARView({ onError, onStop }: ARViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const debugCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackingRef = useRef<TrackingState>(createTrackingState());
  const showLandmarksRef = useRef(false);
  const invalidateRef = useRef<(() => void) | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [phase, setPhase] = useState<Phase>('camera');
  const [handStatus, setHandStatus] = useState<HandStatus>('none');
  const [fps, setFps] = useState(0);
  const [delegate, setDelegate] = useState<Delegate | null>(null);
  const [showLandmarks, setShowLandmarks] = useState(false);

  useEffect(() => {
    showLandmarksRef.current = showLandmarks;
    if (!showLandmarks) {
      const canvas = debugCanvasRef.current;
      canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, [showLandmarks]);

  useEffect(() => {
    const video = videoRef.current!;
    const stage = stageRef.current!;
    const debugCanvas = debugCanvasRef.current!;
    const debugCtx = debugCanvas.getContext('2d')!;
    const tracking = trackingRef.current;

    // Each camera frame is copied here once; detection and the scene's
    // background both use this copy, so they always agree on the frame.
    const capture = document.createElement('canvas');
    const captureCtx = capture.getContext('2d', { alpha: false })!;
    tracking.frame = capture;
    const landmarkFilter = new LandmarkFilter();
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
    let status: HandStatus = 'none';
    let handednessVotes = 0;
    let fpsFrames = 0;
    let fpsWindowStart = performance.now();
    let debugDirty = false;
    let videoFramesSeen = 0;

    /** Captures the current video frame, detects on it and requests one render. */
    const processFrame = (now: number) => {
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
      const result = landmarker.detectForVideo(capture, timestamp);

      const raw = result.landmarks[0] ?? null;
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
          }
        } else {
          handednessVotes = 0;
        }
      } else {
        landmarkFilter.reset();
      }
      const landmarks = raw ? landmarkFilter.filter(raw, timestamp / 1000, width, height) : null;
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

      if (showLandmarksRef.current && view.width > 0) {
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

      fpsFrames++;
      const elapsed = now - fpsWindowStart;
      if (elapsed >= FPS_UPDATE_MS) {
        setFps(Math.round((fpsFrames * 1000) / elapsed));
        fpsFrames = 0;
        fpsWindowStart = now;
      }
    };

    // Preferred: run exactly once per new video frame, as it is presented.
    const onVideoFrame: VideoFrameRequestCallback = (now) => {
      videoFrameHandle = video.requestVideoFrameCallback(onVideoFrame);
      videoFramesSeen++;
      processFrame(now);
    };
    // Fallback: poll on animation frames and skip repeats.
    const onAnimationFrame = (now: number) => {
      rafId = requestAnimationFrame(onAnimationFrame);
      if (video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;
      processFrame(now);
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

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        onErrorRef.current(UNSUPPORTED_MESSAGE);
        return;
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
        return;
      }
      if (cancelled) {
        stopStream(mediaStream);
        return;
      }
      stream = mediaStream;
      video.srcObject = mediaStream;
      try {
        await video.play();
      } catch {
        // play() rejects if we unmount mid-start; autoplay attribute covers the rest.
      }
      if (cancelled) return;

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
      window.clearTimeout(watchdog);
      if ('cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(videoFrameHandle);
      resizeObserver.disconnect();
      landmarker?.close();
      landmarker = null;
      if (stream) stopStream(stream);
      video.srcObject = null;
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
          <ARScene tracking={trackingRef} onReady={onSceneReady} />
        </div>
        <canvas ref={debugCanvasRef} className="layer debug" />
      </div>

      <Hud
        handStatus={handStatus}
        fps={fps}
        delegate={delegate}
        running={phase === 'running'}
        showLandmarks={showLandmarks}
        onToggleLandmarks={() => setShowLandmarks((v) => !v)}
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
