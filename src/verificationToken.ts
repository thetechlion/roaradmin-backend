// Generates a one-time token in the form "RA-1234ABCD": "RA-" prefix, four
// digits, four uppercase letters. The signing-up user pastes this anywhere
// in their Roblox profile description to prove they control that account,
// then RoarAdmin checks their live bio for it before the account is created.

export function generateVerificationToken(): string {
  const digitBytes = crypto.getRandomValues(new Uint8Array(4));
  const letterBytes = crypto.getRandomValues(new Uint8Array(4));

  const digits = Array.from(digitBytes, (b) => (b % 10).toString()).join("");
  const letters = Array.from(letterBytes, (b) => String.fromCharCode(65 + (b % 26))).join("");

  return `RA-${digits}${letters}`;
}
