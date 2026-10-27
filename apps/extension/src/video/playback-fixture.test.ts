import { afterEach, describe, expect, it, vi } from "vitest";
import { readVideoPixels } from "./playback-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function player() {
  const video = document.createElement("video");
  let present!: VideoFrameRequestCallback;
  video.requestVideoFrameCallback = vi.fn((callback) => {
    present = callback;
    return 1;
  });
  video.cancelVideoFrameCallback = vi.fn();
  vi.spyOn(video, "pause").mockImplementation(() => {});
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 255, 255]) }),
  } as unknown as CanvasRenderingContext2D);
  return {
    video,
    drawImage,
    seeked: () => video.dispatchEvent(new Event("seeked")),
    present: () => present(0, {} as VideoFrameCallbackMetadata),
  };
}

describe("video pixel sampling", () => {
  it.each([
    "seeked",
    "present",
  ] as const)("waits for both signals when %s arrives first", async (first) => {
    const fixture = player();
    const pixels = readVideoPixels(fixture.video, [1.5]);
    fixture[first]();
    await Promise.resolve();
    expect(fixture.drawImage).not.toHaveBeenCalled();
    fixture[first === "seeked" ? "present" : "seeked"]();
    await expect(pixels).resolves.toEqual([[0, 0, 255, 255]]);
    expect(fixture.drawImage).toHaveBeenCalledTimes(1);
    expect(fixture.video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
  });

  it("fails instead of reading a stale frame when presentation never arrives", async () => {
    vi.useFakeTimers();
    const fixture = player();
    const pixels = readVideoPixels(fixture.video, [1.5]);
    const rejected = expect(pixels).rejects.toThrow("seeked=true, presented=false");
    fixture.seeked();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(fixture.drawImage).not.toHaveBeenCalled();
    expect(fixture.video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
  });
});
