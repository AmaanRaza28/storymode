/**
 * Pull the final frame out of a rendered scene, in the browser.
 *
 * fal hands back a video url and nothing else, so the closing still has to be recovered
 * by decoding the video. Doing that here rather than on the server keeps ffmpeg out of
 * the deployment entirely, and the author is already sitting in front of a browser that
 * has the clip decoded for playback.
 *
 * The video is fetched through our own origin first. A canvas that has drawn a
 * cross-origin frame refuses to be read back, so the bytes are turned into a blob url —
 * which is same-origin by definition — before anything is drawn.
 */

/** Nudge back from the very end: seeking exactly to `duration` lands past the last frame. */
const END_EPSILON_SECONDS = 0.08;
/** Fallback seek target for streams that report a non-finite duration; browsers clamp it. */
const FAR_FUTURE_SECONDS = 1e6;
const CAPTURE_TIMEOUT_MS = 30_000;

function waitForEvent(target: HTMLVideoElement, event: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    }
    function onEvent() {
      cleanup();
      resolve();
    }
    function onError() {
      cleanup();
      reject(new Error("This video could not be decoded in the browser"));
    }
    function onAbort() {
      cleanup();
      reject(new Error("Capturing the last frame took too long"));
    }
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function drawLastFrame(objectUrl: string, signal: AbortSignal): Promise<Blob> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = objectUrl;

  try {
    await waitForEvent(video, "loadedmetadata", signal);

    // A fragmented stream can report Infinity here; seeking far past the end makes the
    // browser clamp to the real duration and report it back.
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      video.currentTime = FAR_FUTURE_SECONDS;
      await waitForEvent(video, "seeked", signal);
    }

    const target = Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(0, video.duration - END_EPSILON_SECONDS)
      : video.currentTime;

    // Seeking to where we already are fires no event, so only wait when we actually move.
    if (Math.abs(video.currentTime - target) > 0.001) {
      video.currentTime = target;
      await waitForEvent(video, "seeked", signal);
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("This video reported no picture size");

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser would not provide a drawing context");
    context.drawImage(video, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob
          ? resolve(blob)
          : reject(new Error("The captured frame could not be encoded")),
        "image/jpeg",
        0.92,
      );
    });
  } finally {
    // Drop the decoder before the object url is revoked.
    video.removeAttribute("src");
    video.load();
  }
}

/**
 * Capture the closing frame of a scene's video and hand it back as a JPEG.
 * `gameId`/`nodeId` address the scene; the video itself is read through the proxy so the
 * canvas stays readable.
 */
export async function captureSceneLastFrame(gameId: string, nodeId: string): Promise<Blob> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);

  let objectUrl: string | undefined;
  try {
    const response = await fetch(
      `/api/frames/video?gameId=${encodeURIComponent(gameId)}&nodeId=${encodeURIComponent(nodeId)}`,
      { signal: controller.signal },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? "Unable to read this scene's video");
    }
    objectUrl = URL.createObjectURL(await response.blob());
    return await drawLastFrame(objectUrl, controller.signal);
  } finally {
    window.clearTimeout(timer);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
