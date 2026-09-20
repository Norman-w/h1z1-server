import assert from "node:assert/strict";
import test from "node:test";
import { ZonePacketHandlers } from "../out/servers/ZoneServer2016/zonepackethandlers";

const point = (x: number, y: number, z: number) =>
  new Float32Array([x, y, z, 1]);

function fixture(playerSequenceTime: number) {
  const passenger = {
    characterId: "passenger",
    positionUpdate: {
      position: point(10, 4.5, 20),
      sequenceTime: playerSequenceTime
    },
    state: { position: point(10, 4.5, 20) }
  } as any;
  const passengerClient = { startLoc: 0 } as any;
  const vehicle = {
    characterId: "vehicle",
    vehicleId: 2,
    engineOn: false,
    state: { position: point(0, 0, 0) },
    positionUpdate: {},
    oldPos: { position: point(0, 0, 0), time: 0 },
    getPassengerList: () => ["passenger"],
    removePassenger() {}
  } as any;
  const server = {
    _transientIds: { 17: "vehicle" },
    _characterIds: {},
    _vehicles: { vehicle },
    _characters: { passenger },
    _protocol: { createManagedPositionBroadcast2016: (raw: unknown) => raw },
    getClientByCharId(characterId: string) {
      return characterId === "passenger" ? passengerClient : undefined;
    },
    sendRawToAllOthersWithSpawnedEntity() {}
  } as any;
  const client = {
    managedObjects: ["vehicle"],
    blockedPositionUpdates: 0,
    character: { isAlive: true, isSpectator: false }
  } as any;
  return { server, client, passenger, passengerClient };
}

test("managed vehicle updates retain a current passenger world position", async () => {
  const { server, client, passenger, passengerClient } = fixture(120);
  await ZonePacketHandlers.prototype.PlayerUpdateManagedPosition.call(
    {},
    server,
    client,
    {
      data: {
        transientId: 17,
        positionUpdate: {
          flags: 2,
          sequenceTime: 119,
          position: point(10, 2, 20),
          raw: Buffer.alloc(0)
        }
      }
    }
  );

  assert.deepEqual(Array.from(passenger.state.position), [10, 4.5, 20, 1]);
  assert.equal(passenger.lastMountedPositionSource, "player-update");
  assert.equal(passenger.lastMountedPositionSequenceTime, 120);
  assert.equal(passengerClient.startLoc, 4.5);
});

test("managed vehicle updates use the vehicle root after the passenger sample becomes stale", async () => {
  const { server, client, passenger } = fixture(118);
  await ZonePacketHandlers.prototype.PlayerUpdateManagedPosition.call(
    {},
    server,
    client,
    {
      data: {
        transientId: 17,
        positionUpdate: {
          flags: 2,
          sequenceTime: 119,
          position: point(12, 2, 20),
          raw: Buffer.alloc(0)
        }
      }
    }
  );

  assert.deepEqual(Array.from(passenger.state.position), [12, 2, 20, 1]);
  assert.equal(passenger.lastMountedPositionSource, "vehicle-root");
  assert.equal(passenger.lastMountedPositionSequenceTime, 119);
});

test("a delayed mounted passenger packet cannot rewind a newer vehicle position", () => {
  const { server, passenger } = fixture(120);
  const vehicle = server._vehicles.vehicle;
  vehicle.state.position = point(30, 2, 20);
  vehicle.oldPos.time = 200;
  server.explosiveManager = { explosiveEntities: new Map() };

  const client = {
    vehicle: { mountedVehicle: "vehicle" },
    blockedPositionUpdates: 0,
    characterReleased: false,
    avgPing: 0,
    isWeaponLock: false,
    lastMovementImpared: 0,
    character: {
      characterId: "passenger",
      isAlive: true,
      isSpectator: false,
      isVanished: false,
      tempGodMode: false,
      state: { position: point(30, 2, 20) },
      positionUpdate: {},
      checkCurrentInteractionGuid() {}
    }
  } as any;
  const position = point(12, 4.5, 20);

  ZonePacketHandlers.prototype.PlayerUpdatePosition.call(
    {},
    server,
    client,
    {
      data: {
        flags: 2,
        sequenceTime: 150,
        position
      }
    }
  );

  assert.deepEqual(
    Array.from(client.character.state.position),
    [30, 2, 20, 1]
  );
  assert.equal(client.character.lastMountedPositionSource, "vehicle-root");
  assert.equal(client.character.lastMountedPositionSequenceTime, 200);
  assert.deepEqual(Array.from(passenger.state.position), [10, 4.5, 20, 1]);
});
