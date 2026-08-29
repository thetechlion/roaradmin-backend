// Password hashing for RoarAdmin's own login (username + password), separate
// from anything Roblox-issued. PBKDF2-SHA256 via Web Crypto -- no external
// dependency needed, and it's what's available in the Workers runtime
// (bcrypt/scrypt aren't implemented natively here).

const ITERATIONS = 100_000;

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, 256);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hashPassword(
  password: string
): Promise<{ salt: string; hash: string; iterations: number }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashBuf = await pbkdf2(password, salt, ITERATIONS);
  return { salt: toBase64(salt), hash: toBase64(new Uint8Array(hashBuf)), iterations: ITERATIONS };
}

export async function verifyPassword(
  password: string,
  saltB64: string,
  hashB64: string,
  iterations: number
): Promise<boolean> {
  const salt = fromBase64(saltB64);
  const hashBuf = await pbkdf2(password, salt, iterations);
  const computed = toBase64(new Uint8Array(hashBuf));
  return timingSafeEqual(computed, hashB64);
}

/** Minimal strength check -- expand later if you want more rules. */
export function isPasswordAcceptable(password: string): boolean {
  return password.length >= 8;
}
