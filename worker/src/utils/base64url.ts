/** base64url → 原始字节 */
function decodeBase64UrlBytes(b64url: string): Uint8Array {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/** base64url → ArrayBuffer */
export function base64urlToArrayBuffer(b64url: string): ArrayBuffer {
  return decodeBase64UrlBytes(b64url).buffer as ArrayBuffer;
}

/** base64url → UTF-8 string */
export function base64urlToString(b64url: string): string {
  return new TextDecoder("utf-8").decode(decodeBase64UrlBytes(b64url));
}

/** 标准 base64 → ArrayBuffer */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    .buffer as ArrayBuffer;
}
