import { normalizeComputerAddress } from './computer';

export const LAPTOP_PAIRING_QR_PREFIX = 'lectureai-pair:v1';
const PAIRING_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

// QR is intentionally an exact three-field payload: version, private helper
// base URL, and an eight-character pairing code. It never contains a bearer
// token, a path, query string, credentials, or a public/tunnel address.
export function parseLaptopPairingQr(value) {
  const parts = String(value || '').trim().split('|');
  if (parts.length !== 3 || parts[0] !== LAPTOP_PAIRING_QR_PREFIX) {
    throw new Error('This is not a LectureAI Laptop AI pairing QR code.');
  }
  const address = normalizeComputerAddress(parts[1]);
  const code = String(parts[2] || '').trim().toUpperCase();
  if (!PAIRING_CODE.test(code)) throw new Error('This Laptop AI QR code has an invalid pairing code.');
  return { address, code };
}
