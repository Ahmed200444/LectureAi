import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const phoneSource = readFileSync(new URL('../expo-recorder/src/qr-pairing.js', import.meta.url), 'utf8');
const laptopGenerator = readFileSync(new URL('../local-ai/pairing.py', import.meta.url), 'utf8');
const privateAddressNormalizer = `
function normalizeComputerAddress(value) {
  const candidate = String(value || '').trim();
  const parsed = new URL(candidate);
  const octets = parsed.hostname.split('.').map(Number);
  const privateV4 = octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  if (parsed.protocol !== 'http:' || !privateV4 || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.port) throw new Error('invalid private helper address');
  return parsed.toString().replace(/\\/$/, '');
}`;
const phoneParser = Function(`${phoneSource.replace("import { normalizeComputerAddress } from './computer';", privateAddressNormalizer).replaceAll('export ', '')}\nreturn parseLaptopPairingQr;`)();

// test_pairing.py executes laptop_pairing_qr() and asserts this exact output.
// This test executes the actual phone parser source against that generator output.
const payload = 'lectureai-pair:v1|http://192.168.1.25:8765|ABCDEFGH';
assert.match(laptopGenerator, /return f"\{PAIRING_QR_PREFIX\}\|\{normalized_address\}\|\{normalized_code\}"/);
assert.equal(payload, 'lectureai-pair:v1|http://192.168.1.25:8765|ABCDEFGH');
assert.ok(!/bearer|token|secret/i.test(payload), 'the generated QR must not include an authorization token');
assert.deepEqual(phoneParser(payload), { address: 'http://192.168.1.25:8765', code: 'ABCDEFGH' });
assert.throws(() => phoneParser('lectureai-pair:v1|http://8.8.8.8:8765|ABCDEFGH'));
assert.throws(() => phoneParser('lectureai-pair:v1|http://192.168.1.25:8765/path|ABCDEFGH'));
assert.throws(() => phoneParser('lectureai-pair:v1|http://192.168.1.25:8765|ABCDEFGH|token'));
console.log('✓ laptop QR generator and phone parser share one private pairing payload protocol');
