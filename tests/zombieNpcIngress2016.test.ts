import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual methods without importing server constructors or out.
function sourceMethod(relative: string, className: string, methodName: string) {
  const filename = path.resolve(relative);
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className) as ts.ClassDeclaration;
  assert.ok(owner);
  const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === methodName);
  assert.ok(method);
  const output = ts.transpileModule(`class Selected { ${method.getText(source)} }\nmodule.exports = Selected;`, {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(output, { module, Buffer, console: { log() {}, error() {} } }, { filename });
  return module.exports.prototype[methodName];
}

const handler = sourceMethod("src/servers/ZoneServer2016/zonepackethandlers.ts", "ZonePacketHandlers", "PlayerUpdateManagedPosition");
const forward = sourceMethod("src/servers/ZoneServer2016/managers/devhttpserver.ts", "DevHttpServer", "observeTestNpcIngress");

function fixture() {
  const calls: unknown[][] = [];
  const npc = { characterId: "npc", state: { position: [10, 20, 30] } };
  const client: any = { character: { isSpectator: false, isAlive: true }, managedObjects: [] };
  const server: any = { _npcs: { npc }, _transientIds: { 42: "npc" }, _vehicles: {}, _throwableProjectiles: {},
    sendData() { throw Error("unexpected send"); }, sendRawToAllOthersWithSpawnedEntity() { throw Error("unexpected broadcast"); } };
  const replay = { observeNpcIngress(c: unknown, data: unknown) { calls.push([c, data]); } };
  server._devHttpServer = { observeTestNpcIngress(c: unknown, data: unknown) { forward.call({ testReplay: replay }, c, data); } };
  return { server, client, npc, calls };
}

for (const flags of [0, 8191, undefined]) {
  test(`actual NPC ingress forwarding precedes flags=${flags} and normal-NPC discard`, async () => {
    const s = fixture();
    const data = { transientId: 42, positionUpdate: { flags, position: [99, 98, 97], horizontalSpeed: 5 } };
    await handler.call({}, s.server, s.client, { data });
    assert.equal(s.calls.length, 1); assert.equal(s.calls[0][0], s.client); assert.equal(s.calls[0][1], data);
    assert.deepEqual(s.npc.state.position, [10, 20, 30]); assert.deepEqual(s.client.managedObjects, []);
  });
}

test("missing packet data still traverses the inert diagnostic then preserves existing early exit", async () => {
  const s = fixture();
  await handler.call({}, s.server, s.client, { data: undefined });
  assert.equal(s.calls.length, 1); assert.equal(s.calls[0][1], undefined);
});

test("disabled dev diagnostics leave normal NPC handling unchanged", async () => {
  const s = fixture(); delete s.server._devHttpServer;
  await handler.call({}, s.server, s.client, { data: { transientId: 42, positionUpdate: { flags: 8191, position: [1, 2, 3] } } });
  assert.equal(s.calls.length, 0); assert.deepEqual(s.npc.state.position, [10, 20, 30]);
});

test("throwing observation cannot prevent the existing vehicle ownership gate", async () => {
  const s = fixture(); let ownershipChecks = 0;
  s.server._vehicles.npc = s.npc;
  s.client.managedObjects = { includes(id: string) { assert.equal(id, "npc"); ownershipChecks++; return false; } };
  s.server._devHttpServer.observeTestNpcIngress = () => { throw Error("observation failed"); };
  await handler.call({}, s.server, s.client, { data: { transientId: 42, positionUpdate: { flags: 8191, position: [1, 2, 3] } } });
  assert.equal(ownershipChecks, 1); assert.deepEqual(s.npc.state.position, [10, 20, 30]);
});

test("source forwarder preserves exact object identities and returns no control/position result", () => {
  const calls: unknown[][] = [], client = {}, data = {};
  const result = forward.call({ testReplay: { observeNpcIngress(...args: unknown[]) { calls.push(args); return { mustNotEscape: true }; } } }, client, data);
  assert.equal(result, undefined); assert.equal(calls.length, 1); assert.equal(calls[0][0], client); assert.equal(calls[0][1], data);
});
