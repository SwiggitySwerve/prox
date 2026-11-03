/** Bound a streamed body before decoding it; callers own status and validation. */
export async function readText(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  tooLarge = 'Response too large'
): Promise<string> {
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
    return text + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Bound streamed JSON before parsing; callers own status and domain validation. */
export async function readJson(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  tooLarge = 'Response too large'
): Promise<unknown> {
  return JSON.parse(await readText(body, maximumBytes, tooLarge));
}
