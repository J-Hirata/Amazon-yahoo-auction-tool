import {build} from 'esbuild';
import path from 'node:path';
import {createHash} from 'node:crypto';

function modulePath(value) {
  const name='/'+value.replaceAll('\\','/');
  // Nested dependencies are classified by their own package, not their parent.
  const start=name.lastIndexOf('/node_modules/');
  if(start<0)return null;
  const parts=name.slice(start+'/node_modules/'.length).split('/');
  const count=parts[0].startsWith('@')?2:1;
  return {name:parts.slice(0,count).join('/'),file:parts.slice(count).join('/')};
}

export function authBoundaryViolations(files,surface) {
  if(!['browser','function'].includes(surface))throw new TypeError('Unknown build surface');
  return files.filter(file=>{
    const module=modulePath(file);if(!module)return false;
    const auth=module.name==='better-auth'||module.name.startsWith('@better-auth/')||/^@neondatabase\/auth(?:-ui)?$/.test(module.name);
    const email=module.name.startsWith('@react-email/')||['deepmerge','html-to-text'].includes(module.name);
    if(surface==='function')return auth||email;
    return email||module.name==='@better-auth/drizzle-adapter'||module.name==='@better-auth/kysely-adapter'||
      module.name==='better-auth'&&(/^dist\/(?:api|db|adapters|auth)\//.test(module.file)||
        /^dist\/plugins\/(?:magic-link|oauth-proxy)\//.test(module.file)&&!/^dist\/plugins\/[^/]+\/client(?:[.-]|$)/.test(module.file));
  });
}

export function emittedInputs(metafile) {
  return [...new Set(Object.values(metafile.outputs).flatMap(output=>Object.entries(output.inputs).filter(([,input])=>input.bytesInOutput>0).map(([name])=>name)))];
}

export async function inspectAuthBrowserBoundary(root) {
  const result=await build({entryPoints:[path.join(root,'public','cloud-login.js')],bundle:true,write:false,metafile:true,
    format:'esm',target:['es2022'],platform:'browser',minify:true,logLevel:'silent',
    external:['./monitor-http.js','./link-monitor.js','./physical-stock.js','./app.js','./sales-planning.js','./product-overview.js']});
  const inputs=emittedInputs(result.metafile);
  return {inputCount:inputs.length,bundleHash:createHash('sha256').update(result.outputFiles[0].contents).digest('hex'),violations:authBoundaryViolations(inputs,'browser')};
}
