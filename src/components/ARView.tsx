import { useEffect, useRef, useState } from 'react';
import type { HandLandmarker } from '@mediapipe/tasks-vision';
import { createHandLandmarker, type Delegate } from '../lib/handLandmarker';
import { computeCover, createCoverRect } from '../lib/coverMapping';
import { drawLandmarks } from '../lib/drawLandmarks';
import { CLOSED_HAND_SCORE, OPEN_HAND_SCORE } from '../lib/handPose';
import { createTrackingState, handOpenness, type TrackingState } from '../lib/tracking';
import { ARScene } from './ARScene';
import { Hud, type HandStatus } from './Hud';

/** Frames a new handedness label must persist before we believe it. */
const HANDEDNESS_HYSTERESIS = 5;
const FPS_UPDATE_MS = 500;

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
    tracking.video = video;

    let cancelled = false;
    let rafId = 0;
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

    const tick = () => {
      rafId = requestAnimationFrame(tick);
      if (!landmarker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      // Only run inference when the camera has delivered a new frame.
      if (video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;

      const now = performance.now();
      const timestamp = Math.max(now, lastTimestamp + 1); // must strictly increase
      lastTimestamp = timestamp;
      const result = landmarker.detectForVideo(video, timestamp);

      const landmarks = result.landmarks[0] ?? null;
      if (landmarks) {
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
          }
        } else {
          handednessVotes = 0;
        }
      }
      if (landmarks) {
        const openness = handOpenness(landmarks, video.videoWidth, video.videoHeight);
        tracking.handOpen = openness > (tracking.handOpen ? CLOSED_HAND_SCORE : OPEN_HAND_SCORE);
      } else {
        tracking.handOpen = false;
      }
      tracking.landmarks = landmarks;
      tracking.frameId++;
      handPresent = landmarks !== null;

      const nextStatus: HandStatus = !handPresent ? 'none' : tracking.handOpen ? 'open' : 'closed';
      if (nextStatus !== status) {
        status = nextStatus;
        setHandStatus(nextStatus);
      }

      if (showLandmarksRef.current && view.width > 0 && video.videoWidth) {
        debugCtx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
        debugCtx.clearRect(0, 0, view.width, view.height);
        if (landmarks) {
          computeCover(cover, view.width, view.height, video.videoWidth, video.videoHeight);
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

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        onErrorRef.current(UNSUPPORTED_MESSAGE);
        return;
      }

      let mediaStream: MediaStream;
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
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
      rafId = requestAnimationFrame(tick);
    };

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      landmarker?.close();
      landmarker = null;
      if (stream) stopStream(stream);
      video.srcObject = null;
      tracking.landmarks = null;
      tracking.handOpen = false;
      tracking.video = null;
    };
  }, []);

  return (
    <div className="ar-root">
      {/* Everything in the stage is mirrored together, like a selfie camera. */}
      <div className="stage" ref={stageRef}>
        <video ref={videoRef} className="layer video" autoPlay playsInline muted />
        <div className="layer">
          <ARScene tracking={trackingRef} />
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
