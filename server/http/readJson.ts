/** Bound streamed JSON before parsing; callers own status and domain validation. */
export async function readJson(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  tooLarge = 'Response too large'
): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) throw new Error(tooLarge);
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
