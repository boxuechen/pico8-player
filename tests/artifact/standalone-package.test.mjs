import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

test("extracted standalone release runs a tool loop without repository or node_modules imports", async () => {
  const dir=await mkdtemp(join(tmpdir(),'p8-session-consumer-'));
  try {
    execFileSync('tar',['-xzf',resolve('apps/web-player/dist/package/pico8-web-player-0.2.0-alpha.2.tar.gz'),'-C',dir]);
    const root=join(dir,'pico8-web-player-0.2.0-alpha.2');
    execFileSync(process.execPath,['verify.mjs'],{cwd:root});
    const {createPico8Session,createPico8SessionTool}=await import(pathToFileURL(join(root,'main/player.mjs')));
    const s=await createPico8Session();
    try {
      const tool=createPico8SessionTool(s);
      await tool.execute({action:'load_source',source:'function _draw() cls(8) end'});
      const result=await tool.execute({action:'advance',frames:2});
      assert.equal(result.completedFrames,2);
      assert.equal(result.observation.frame.frameId,1);
      assert.equal(result.observation.frame.encoding,'rgba8-base64');
    } finally {await s.dispose();}
  } finally {await rm(dir,{recursive:true,force:true});}
});
