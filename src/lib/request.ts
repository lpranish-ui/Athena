/** Fetch both headers and body within a deadline, including on flaky networks. */
export async function fetchText(
  url: string,
  options: RequestInit,
  timeoutMs = 30000,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('The request timed out. Please try again.'));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return { ok: response.ok, status: response.status, text: await response.text() };
      })(),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
