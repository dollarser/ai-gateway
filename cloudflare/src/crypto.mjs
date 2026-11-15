import { scryptAsync } from "@noble/hashes/scrypt";
const utf8 = new TextEncoder();
export const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export const now = () => Date.now() / 1000;
export const token = (prefix = "") =>
  prefix + hex(crypto.getRandomValues(new Uint8Array(24)));
export async function digest(text) {
  return hex(await crypto.subtle.digest("SHA-256", utf8.encode(text)));
}
export function equal(a, b) {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}
export async function passwordHash(password, salt = token().slice(0, 32)) {
  const bytes = Uint8Array.from(salt.match(/../g), (h) => parseInt(h, 16));
  const value = await scryptAsync(utf8.encode(password), bytes, {
    N: 16384,
    r: 8,
    p: 1,
    dkLen: 64,
    maxmem: 64 * 1024 * 1024,
  });
  return salt + ":" + hex(value);
}
export async function checkPassword(password, encoded) {
  if (!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded)) return false;
  return equal(await passwordHash(password, encoded.split(":")[0]), encoded);
}
