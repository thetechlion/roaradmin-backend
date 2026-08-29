// AES-256-GCM encryption for secrets we store in D1 (currently: each org's
// Roblox Open Cloud API key). The key comes from a Wrangler secret so it
// never lives in source control or the database itself.
//
// Set it once with:
//   wrangler secret put ENCRYPTION_KEY
// Value must be a base64-encoded 32-byte key, e.g. generate with:
//   openssl rand -base64 32

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function encryptSecret(
  plaintext: string,
  base64Key: string
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    ciphertext: toBase64(new Uint8Array(ciphertextBuf)),
    iv: toBase64(iv),
  };
}

export async function decryptSecret(
  ciphertextB64: string,
  ivB64: string,
  base64Key: string
): Promise<string> {
  const key = await importKey(base64Key);
  const iv = fromBase64(ivB64);
  const ciphertext = fromBase64(ciphertextB64);

  const plaintextBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintextBuf);
}
