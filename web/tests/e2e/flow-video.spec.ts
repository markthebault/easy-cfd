import { expect, test } from "@playwright/test";

const source = process.env.EASYCFD_FLOW_VIDEO;

test.use({ viewport: { width: 1920, height: 1080 } });

test("the generated airflow movie decodes and plays in every view", async ({ page }) => {
  test.skip(!source, "Requires a rendered airflow movie served over HTTP.");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setContent('<style>body{margin:0;background:#080e16}video{display:block;width:100vw;height:100vh;object-fit:contain}</style><video data-testid="movie" controls muted playsinline></video>');
  const video = page.getByTestId("movie");
  await video.evaluate((element, url) => { (element as HTMLVideoElement).src = url; }, source!);
  await expect(video).toHaveJSProperty("videoWidth", 1920);
  await expect(video).toHaveJSProperty("videoHeight", 1080);
  const duration = await video.evaluate(element => (element as HTMLVideoElement).duration);
  expect(duration).toBeGreaterThanOrEqual(6);
  for (const [chapter, label] of ["body", "wake", "centreline"].entries()) {
    const time = (chapter + .5) * duration / 3;
    await video.evaluate(async (element, time) => {
      const movie = element as HTMLVideoElement;
      movie.currentTime = time;
      await movie.play();
    }, time);
    await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(time + .4);
    await video.evaluate(element => (element as HTMLVideoElement).pause());
    expect(await video.evaluate(element => (element as HTMLVideoElement).error)).toBeNull();
    await page.screenshot({ path: `test-results/video-${label}.png` });
  }
  const quality = await video.evaluate(element => {
    const movie = element as HTMLVideoElement;
    const quality = movie.getVideoPlaybackQuality();
    return { decoded: quality.totalVideoFrames, dropped: quality.droppedVideoFrames };
  });
  expect(quality.decoded).toBeGreaterThan(20);
  expect(quality.dropped / quality.decoded).toBeLessThan(.1);
  await test.info().attach("playback-quality", { body: JSON.stringify(quality), contentType: "application/json" });
  expect(errors).toEqual([]);
});
