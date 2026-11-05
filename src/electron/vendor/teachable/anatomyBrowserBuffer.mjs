// Minimal adapter for turn-build.mjs's byte-array-to-base64 operation.
// This does not expose Node.js, filesystem access, or a general Buffer API.
export const Buffer = Object.freeze({ from(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected bytes');
  return { toString(encoding) {
    if (encoding !== 'base64') throw new TypeError('Only base64 is supported');
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x4000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
    return btoa(binary);
  } };
} });
