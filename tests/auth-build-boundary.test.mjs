import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {authBoundaryViolations,emittedInputs,inspectAuthBrowserBoundary} from '../scripts/auth-build-boundary.mjs';

test('browser auth clients and similarly named icons do not imply server handlers',()=>{
  const paths=['node_modules/better-auth/dist/client/vanilla.mjs','node_modules/better-auth/dist/plugins/magic-link/client.mjs',
    'node_modules/better-auth/dist/plugins/admin/access/statement.mjs','node_modules/@better-auth/core/dist/env/logger.mjs',
    'node_modules/lucide/dist/esm/icons/cloud-drizzle.mjs','src/cloud-auth.js'];
  assert.deepEqual(authBoundaryViolations(paths,'browser'),[]);
});

test('vulnerable server handlers, adapters and email dependencies cannot enter a browser build',()=>{
  const paths=['node_modules/better-auth/dist/plugins/magic-link/index.mjs','node_modules/better-auth/dist/plugins/oauth-proxy/index.mjs',
    'node_modules/better-auth/dist/api/routes/callback.mjs','node_modules/better-auth/dist/db/schema.mjs',
    'node_modules/@better-auth/drizzle-adapter/dist/index.mjs','node_modules/deepmerge/dist/cjs.js','node_modules/@react-email/render/dist/node/index.mjs'];
  assert.deepEqual(authBoundaryViolations(paths,'browser'),paths);
});

test('the JWT-only API function must not ship auth SDKs or server-side auth packages',()=>{
  const paths=['node_modules/@neondatabase/auth/dist/index.mjs','node_modules/better-auth/dist/client/index.mjs',
    'node_modules/@better-auth/core/dist/index.mjs','node_modules/html-to-text/lib/html-to-text.cjs'];
  assert.deepEqual(authBoundaryViolations(paths,'function'),paths);
  assert.deepEqual(authBoundaryViolations(['node_modules/jose/dist/webapi/jwt/verify.js','src/cloud-auth.js','package.json'],'function'),[]);
});

test('nested and Windows module paths keep their package boundary',()=>{
  const paths=['D:\\app\\node_modules\\better-auth\\dist\\plugins\\magic-link\\index.mjs',
    'node_modules/other/node_modules/deepmerge/index.js'];
  assert.deepEqual(authBoundaryViolations(paths,'browser'),paths);
  assert.throws(()=>authBoundaryViolations([],'other'),TypeError);
});

test('parsed but tree-shaken modules are not reported as shipped code',()=>{
  assert.deepEqual(emittedInputs({outputs:{'one.js':{inputs:{'safe.js':{bytesInOutput:10},'unused.js':{bytesInOutput:0}}},
    'two.js':{inputs:{'safe.js':{bytesInOutput:4},'other.js':{bytesInOutput:1}}}}}),['safe.js','other.js']);
});

test('the actual Neon login bundle excludes the audited server-only paths',async()=>{
  const result=await inspectAuthBrowserBoundary(fileURLToPath(new URL('../',import.meta.url)));
  assert.ok(result.inputCount>0);assert.match(result.bundleHash,/^[0-9a-f]{64}$/);assert.deepEqual(result.violations,[]);
});
