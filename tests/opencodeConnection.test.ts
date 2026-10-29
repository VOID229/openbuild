import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "../server/opencode-agent/connection";
import { forgetModels, listModels, status } from "../server/opencode-agent/install";
const dir = mkdtempSync(join(tmpdir(), "ob-opencode-connection-"));
const bin = join(dir, "opencode");
const log = join(dir, "log");
const names = ["OPENCODE_BIN", "OPENCODE_SERVER_URL", "OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD", "OC_FIXTURE_LOG", "OC_FIXTURE_VERSION"] as const;
const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
writeFileSync(bin, `#!${process.execPath}\n` + String.raw`
import {appendFileSync} from 'node:fs';
if (process.argv.slice(2).join(' ') !== 'serve --hostname=127.0.0.1 --port=0') throw new Error('wrong launch args');
appendFileSync(process.env.OC_FIXTURE_LOG,JSON.stringify({pid:process.pid,password:process.env.OPENCODE_PASSWORD,inherited:process.env.OPENCODE_SERVER_PASSWORD})+'\n');
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req){
 const expected='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64');
 if(req.headers.get('authorization')!==expected)return new Response('unauthorized',{status:401});
 const path=new URL(req.url).pathname;
 if(path==='/api/info')return Response.json({version:process.env.OC_FIXTURE_VERSION||'2.0.32'});
 if(path==='/api/model')return Response.json({data:[]});
 if(path==='/api/model/default')return Response.json({data:null});
 return Response.json({data:{}});
}});
console.log('opencode server listening on '+server.url);
`);
chmodSync(bin, 0o700);
process.env.OPENCODE_BIN = bin; delete process.env.OPENCODE_SERVER_URL;
process.env.OPENCODE_SERVER_PASSWORD = "must-not-inherit"; process.env.OPENCODE_PASSWORD = "must-be-replaced"; process.env.OC_FIXTURE_LOG = log;
const rows = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
function exited(pid: number) { try { process.kill(pid, 0); return false; } catch { return true; } }
afterAll(() => { for (const n of names) { if (old[n] === undefined) delete process.env[n]; else process.env[n] = old[n]; } forgetModels(); rmSync(dir, { recursive: true, force: true }); });

test("local discovery authenticates with random passwords, removes inherited password, and reaps every child", async () => {
  const baseline = process.listenerCount("exit");
  expect((await status()).version).toBe("2.0.32");
  expect((await listModels(true)).models).toEqual([]);
  expect(rows()).toHaveLength(2);
  for (const row of rows()) { expect(row.inherited).toBeUndefined(); expect(row.password).not.toBe("must-be-replaced"); expect(row.password.length).toBeGreaterThan(40); expect(exited(row.pid)).toBe(true); }
  expect(rows()[0].password).not.toBe(rows()[1].password);
  expect(process.listenerCount("exit")).toBe(baseline);
  const connection = await connect();
  const pid = rows().at(-1).pid;
  expect(exited(pid)).toBe(false); await connection.close(); expect(exited(pid)).toBe(true);
});

test("failed v1 handshake also reaps its owned child and exit hook", async () => {
  const baseline = process.listenerCount("exit"); process.env.OC_FIXTURE_VERSION = "1.2.3";
  await expect(connect()).rejects.toThrow("v1");
  expect(exited(rows().at(-1).pid)).toBe(true);
  expect(process.listenerCount("exit")).toBe(baseline);
});
