import { nextTick } from 'vue';

/** Let Vue commit loading state, then let the browser paint it before startup
 * work resumes. */
export async function waitForLoadingOverlayPaint(): Promise<void> {
  await nextTick();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}
