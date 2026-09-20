import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Execute real source methods; no server construction, out, sockets or filesystem observations.
function sourceMethod(relative: string, ownerName: string, methodName: string) {
  const filename = path.resolve(relative);
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const owner = source.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === ownerName) as ts.ClassDeclaration;
  const method = owner.members.find(n => ts.isMethodDeclaration(n) && n.name.getText(source) === methodName);
  assert.ok(method);
  const output = ts.transpileModule(`class Selected { ${method.getText(source)} }\nmodule.exports = Selected;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(output, { module, Buffer, Float32Array, console, debug() {},
    SOEOutputChannels: { Reliable: 0 }, recordTestZombieClockSample() {}, recordTestZombiePositionReceipt() {},
    getCurrentServerTimeWrapper: () => ({ getTruncatedU32: () => 100 }), _: { size: (v: any) => Object.keys(v ?? {}).length } }, { filename });
  return module.exports.prototype[methodName];
}

const inbound = sourceMethod("src/servers/ZoneServer2016/zonepackethandlers.ts", "ZonePacketHandlers", "PlayerUpdatePosition");
const typed = sourceMethod("src/servers/ZoneServer2016/zoneserver.ts", "ZoneServer2016", "_sendData");
const raw = sourceMethod("src/servers/ZoneServer2016/zoneserver.ts", "ZoneServer2016", "_sendRawDataReliable");
const ingressForward = sourceMethod("src/servers/ZoneServer2016/managers/devhttpserver.ts", "DevHttpServer", "observeTestPlayerMotionIngress");
const sendForward = sourceMethod("src/servers/ZoneServer2016/managers/devhttpserver.ts", "DevHttpServer", "observeTestPlayerMotionSend");

function ingressFixture() {
  const calls: any[] = [];
  const client: any = { characterReleased: true, avgPing: 0, character: { isAlive: true, isRespawning: false,
    state: { position: [0, 10, 0, 1] }, checkCurrentInteractionGuid() {} } };
  const server: any = { _devHttpServer: { observeTestPlayerMotionIngress(c: any, data: any) {
    assert.equal(c, client); calls.push({ stage: "receipt", data, position: [...c.character.state.position] });
    return (stage: string) => calls.push({ stage, position: [...c.character.state.position] });
  } } };
  return { server, client, calls };
}

for (const data of [undefined, { flags: 0 }, { flags: 8191, parseError: true }, { flags: 513, stance: 1024 }]) {
  test(`actual ingress diagnostic precedes early return ${JSON.stringify(data)}`, () => {
    const s = ingressFixture(); inbound.call({}, s.server, s.client, { data });
    assert.equal(s.calls.length, 1); assert.equal(s.calls[0].data, data);
    assert.deepEqual(s.client.character.state.position, [0, 10, 0, 1]);
  });
}

test("actual PlayerUpdatePosition brackets the original exact vector assignment", () => {
  const s = ingressFixture(), position = [0, 11, 0, 1];
  inbound.call({}, s.server, s.client, { data: { flags: 2, sequenceTime: 100, position } });
  assert.equal(s.client.character.state.position, position);
  assert.deepEqual(s.calls.map(r => r.stage), ["receipt", "before", "after"]);
  assert.deepEqual(s.calls[1].position, [0, 10, 0, 1]); assert.deepEqual(s.calls[2].position, position);
});

for (const stage of ["missing", "receipt", "before", "after"]) {
  test(`observer ${stage} cannot suppress original assignment`, () => {
    const s = ingressFixture(), position = [0, 11, 0, 1];
    if (stage === "missing") delete s.server._devHttpServer;
    else s.server._devHttpServer.observeTestPlayerMotionIngress = () => {
      if (stage === "receipt") throw Error(stage);
      return (current: string) => { if (current === stage) throw Error(stage); };
    };
    assert.doesNotThrow(() => inbound.call({}, s.server, s.client, { data: { flags: 2, sequenceTime: 100, position } }));
    assert.equal(s.client.character.state.position, position);
  });
}

test("ordinary assignment exception remains the same and after is not called", () => {
  const s = ingressFixture(), error = Error("real assignment failure");
  Object.defineProperty(s.client.character.state, "position", { get: () => [0, 10, 0, 1], set() { throw error; } });
  assert.throws(() => inbound.call({}, s.server, s.client, { data: { flags: 2, position: [0, 11, 0, 1] } }), e => e === error);
  assert.deepEqual(s.calls.map(r => r.stage), ["receipt", "before"]);
});

function sendFixture() {
  const calls: any[] = [], client = { soeClientId: "exact" }, packed = Buffer.from([9, 8]);
  const zone: any = { _devHttpServer: { observeTestPlayerMotionSend(...args: any[]) { calls.push(["observe", ...args]); } },
    _protocol: { pack(name: string, data: any) { calls.push(["pack", name, data]); return packed; } },
    _gatewayServer: { sendTunnelData(...args: any[]) { calls.push(["tunnel", ...args]); } } };
  return { calls, client, packed, zone };
}

for (const name of ["ClientUpdate.UpdateLocation", "Character.Knockback"]) {
  test(`typed ${name} attempt precedes pack and leaves original channel/data unchanged`, () => {
    const s = sendFixture(), payload = { position: [1, 2, 3, 1] };
    assert.equal(typed.call(s.zone, s.client, name, payload, 2), undefined);
    assert.deepEqual(s.calls.map(r => r[0]), ["observe", "pack", "tunnel"]);
    assert.equal(s.calls[0][1], s.client); assert.equal(s.calls[0][3], payload);
    assert.equal(s.calls[2][2], s.packed); assert.equal(s.calls[2][3], 2);
  });
}

for (const failure of ["observer", "null_pack", "pack_throw", "gateway_throw"]) {
  test(`typed diagnostic preserves send behavior for ${failure}`, () => {
    const s = sendFixture(), error = Error(failure);
    if (failure === "observer") s.zone._devHttpServer.observeTestPlayerMotionSend = () => { throw error; };
    if (failure === "null_pack") s.zone._protocol.pack = () => null;
    if (failure === "pack_throw") s.zone._protocol.pack = () => { throw error; };
    if (failure === "gateway_throw") s.zone._gatewayServer.sendTunnelData = () => { throw error; };
    const call = () => typed.call(s.zone, s.client, "ClientUpdate.UpdateLocation", {}, 0);
    if (failure.endsWith("throw")) assert.throws(call, e => e === error); else assert.doesNotThrow(call);
    if (failure === "null_pack") assert.equal(s.calls.filter(r => r[0] === "tunnel").length, 0);
    if (failure === "observer") assert.equal(s.calls.filter(r => r[0] === "tunnel").length, 1);
  });
}

for (const [prefix, name] of [["110a00", "ClientUpdate.UpdateLocation"], ["0f02", "Character.Knockback"]]) {
  for (const size of [prefix.length / 2, 38, 42, 99]) {
    test(`raw ${name} opcode is observed even with length ${size} layout unknown`, () => {
      const s = sendFixture(), data = Buffer.alloc(size); Buffer.from(prefix, "hex").copy(data);
      raw.call(s.zone, s.client, data, 0);
      assert.deepEqual(s.calls.map(r => r[0]), ["observe", "tunnel"]);
      assert.equal(s.calls[0][2], name); assert.equal(s.calls[0][4], data);
      assert.equal(s.calls[1][2], data); assert.equal(s.calls[1][4], 0);
    });
  }
}

test("other packets and movement gateway channels do not enter the outbound observer", () => {
  const s = sendFixture(); typed.call(s.zone, s.client, "Other", {}, 0);
  raw.call(s.zone, s.client, Buffer.from("110a00", "hex"), 2);
  raw.call(s.zone, s.client, Buffer.from("110b00", "hex"), 0);
  raw.call(s.zone, s.client, Buffer.from("0f", "hex"), 0);
  assert.equal(s.calls.filter(r => r[0] === "observe").length, 0);
  assert.equal(s.calls.filter(r => r[0] === "tunnel").length, 4);
});

test("raw observer errors cannot suppress send and real gateway exceptions remain unchanged", () => {
  const s = sendFixture(), data = Buffer.from("110a00", "hex"), error = Error("tunnel");
  s.zone._devHttpServer.observeTestPlayerMotionSend = () => { throw Error("observer"); };
  assert.doesNotThrow(() => raw.call(s.zone, s.client, data));
  assert.equal(s.calls.filter(r => r[0] === "tunnel").length, 1);
  s.zone._gatewayServer.sendTunnelData = () => { throw error; };
  assert.throws(() => raw.call(s.zone, s.client, data), e => e === error);
});

test("dev forwarders retain exact identities; only ingress returns its scoped diagnostic closure", () => {
  const client = {}, data = {}, raw = Buffer.alloc(38), closure = () => {}, calls: any[] = [];
  const owner = { testReplay: {
    observePlayerMotionIngress(...args: any[]) { calls.push(args); return closure; },
    observePlayerMotionSend(...args: any[]) { calls.push(args); return "not_a_send_result"; }
  } };
  assert.equal(ingressForward.call(owner, client, data), closure);
  assert.equal(sendForward.call(owner, client, "ClientUpdate.UpdateLocation", data, raw), undefined);
  assert.equal(calls[0][0], client); assert.equal(calls[0][1], data);
  assert.equal(calls[1][2], data); assert.equal(calls[1][3], raw);
});
