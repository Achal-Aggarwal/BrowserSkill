/** Runs in the player page (also serialized into CDP Runtime.evaluate). */
export async function readVideoPixels(video: HTMLVideoElement, times: number[]) {
  video.pause();
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d")!;
  const pixels: number[][] = [];
  for (const time of times) {
    // seeked can precede presentation of the decoded frame. In particular,
    // drawImage immediately after seeking can still copy the previous frame.
    // Subscribe before seeking so neither event can be missed on a fast decode.
    await new Promise<void>((resolve, reject) => {
      let seeked = false;
      let presented = false;
      let callback = 0;
      const cleanup = () => {
        clearTimeout(timer);
        video.cancelVideoFrameCallback(callback);
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onError);
      };
      const complete = () => {
        if (!seeked || !presented) return;
        cleanup();
        resolve();
      };
      const onSeeked = () => {
        seeked = true;
        complete();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`MP4 playback failed: ${video.error?.message}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `MP4 frame at ${time}s did not become ready (seeked=${seeked}, presented=${presented}, readyState=${video.readyState})`,
          ),
        );
      }, 5000);
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onError);
      callback = video.requestVideoFrameCallback(() => {
        presented = true;
        complete();
      });
      video.currentTime = time;
    });
    context.drawImage(video, 0, 0);
    pixels.push(Array.from(context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data));
  }
  return pixels;
}
