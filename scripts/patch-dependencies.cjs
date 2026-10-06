// Keep SDK 57 compatible while upstream releases for these advisories are pending.
// GHSA-vfj7-8cjw-p6xm (braces), GHSA-86w9-cpqp-85rv (node-forge).
// node-forge element-count fix follows https://github.com/digitalbazaar/forge/pull/1152.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packages = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;

function patch(relative, marker, original, replacement) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) return;
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(marker)) return;
  if (!source.includes(original)) throw new Error(`Security patch needs review after dependency update: ${relative}`);
  fs.writeFileSync(file, source.replaceAll(original, replacement));
}

for (const [directory, metadata] of Object.entries(packages)) {
  if (directory.endsWith('node_modules/braces') && metadata.version === '3.0.3') {
    patch(`${directory}/lib/parse.js`, 'Athena: bound AST nesting',
      'stack.push(block);',
      'stack.push(block);\n      // Athena: bound AST nesting before recursive compile/expand.\n      if (stack.length > 128) throw new SyntaxError("Pattern nesting exceeds the safe limit (128)");');
  }
  if (directory.endsWith('node_modules/node-forge') && metadata.version === '1.4.0') {
    patch(`${directory}/lib/rsa.js`, 'Athena: validate nested DigestAlgorithm',
      'obj.value.length !== 2)',
      "obj.value.length !== 2 ||\n            // Athena: validate nested DigestAlgorithm (OID and optional NULL only).\n            obj.value[0].value.length !== ('parameters' in capture ? 2 : 1))");
  }
  if (directory.endsWith('node_modules/query-string') && metadata.version.startsWith('7.')) {
    patch(`${directory}/index.js`, 'decodeComponentModule',
      "const decodeComponent = require('decode-uri-component');",
      "const decodeComponentModule = require('decode-uri-component');\nconst decodeComponent = decodeComponentModule.default || decodeComponentModule;");
  }
}
