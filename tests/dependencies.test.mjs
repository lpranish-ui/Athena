import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);

test('glob patterns retain normal behavior and reject pathological nesting', () => {
  const braces = require('braces');
  assert.deepEqual(braces.expand('file.{pdf,txt}'), ['file.pdf', 'file.txt']);
  assert.throws(() => braces('{'.repeat(1000) + 'a,b' + '}'.repeat(1000)), /safe limit/);
  assert.throws(() => braces('('.repeat(1000) + 'a' + ')'.repeat(1000)), /safe limit/);
});

test('Router query parsing works with the patched linear decoder', () => {
  const queryString = require('query-string');
  assert.equal(queryString.parse('q=hello%20world').q, 'hello world');
  const malformed = '%FF'.repeat(5000);
  assert.equal(typeof queryString.parse('q=' + malformed).q, 'string');
});

test('RSA signatures work, but nested DigestAlgorithm garbage is rejected', () => {
  const forge = require('node-forge');
  const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  const md = forge.md.sha256.create();
  md.update('Athena dependency regression');
  const digest = md.digest().getBytes();
  assert.equal(publicKey.verify(digest, privateKey.sign(md)), true);
  const asn1 = forge.asn1;
  const sequence = (...children) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, children);
  const node = (type, value) => asn1.create(asn1.Class.UNIVERSAL, type, false, value);
  const malformed = sequence(
    sequence(node(asn1.Type.OID, asn1.oidToDer(forge.oids.sha256).getBytes()),
      node(asn1.Type.NULL, ''), node(asn1.Type.OCTETSTRING, 'extra')),
    node(asn1.Type.OCTETSTRING, digest),
  );
  const forgedStructureSignature = privateKey.sign(asn1.toDer(malformed).getBytes(), 'NONE');
  assert.throws(() => publicKey.verify(digest, forgedStructureSignature), /valid RSASSA/);
});
