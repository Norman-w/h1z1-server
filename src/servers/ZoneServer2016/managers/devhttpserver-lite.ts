import http from "node:http";
import { URL } from "node:url";
import type { ZoneClient2016 } from "../classes/zoneclient";
import type { ZoneServer2016 } from "../zoneserver";
import { flhash } from "../../../utils/utils";
import {
  AnimalTestHarness,
  type AnimalTestType
} from "./animaltestharness";

/**
 * Local-only developer API for the current ZoneServer/NPC implementation.
 *
 * This intentionally does not import the historical replay controller.  The
 * replay controller targets fields removed by the upstream Zone refactor;
 * keeping this small endpoint alive lets the startup script and a human test
 * the production FSM without silently restoring that incompatible stack.
 */
export class DevHttpServerLite {
  private server: http.Server | null = null;
  private readonly tests: AnimalTestHarness;

  constructor(
    private readonly zone: ZoneServer2016,
    private readonly port: number
  ) {
    this.tests = zone.animalTestHarness;
  }

  start(): void {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.listen(this.port, "127.0.0.1", () => {
      console.log(
        `[DevHttp] listening on http://127.0.0.1:${this.port} (current animal test API)`
      );
      console.log(
        "[ztest] current API: POST /api/animal-test {command:flat|slope|hunt|stop|status,type?,distance?,height?,rabbits?,deer?,arrows?}; POST /api/god {enabled?}; POST /api/respawn; POST /api/tp {position:[x,y,z]}"
      );
    });
  }

  stop(): void {
    this.tests.stop();
    this.server?.close();
    this.server = null;
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown
  ): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.writeHead(status);
    res.end(JSON.stringify(body));
  }

  private async readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024) throw new Error("request body too large");
    }
    if (!body.trim()) return {};
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("request body must be a JSON object");
    }
    return value as Record<string, unknown>;
  }

  private clients(): object[] {
    return Object.entries(this.zone._clients).map(([sessionId, client]) => ({
      sessionId,
      soeClientId: client.soeClientId,
      characterId: client.character?.characterId ?? "",
      name: client.character?.name ?? "",
      isLoading: client.isLoading,
      isSynced: client.isSynced,
      // Keep this local-only diagnostic endpoint honest about whether the
      // client can be used by AnimalTestHarness.  The old response exposed
      // only loading/sync flags, which made a death-screen respawn look
      // playable while spawn() was still correctly rejecting it.
      isAlive: client.character?.isAlive ?? null,
      isRespawning: client.character?.isRespawning ?? null,
      isVanished: client.character?.isVanished ?? null,
      isHidden: client.character?.isHidden ?? null,
      godMode: client.character?.isGodMode?.() ?? null,
      position: client.character?.state?.position
        ? Array.from(client.character.state.position)
        : null
    }));
  }

  private soleClient(): ZoneClient2016 {
    const clients = Object.values(this.zone._clients);
    if (clients.length !== 1) {
      throw new Error("exactly one connected client is required");
    }
    return clients[0];
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    try {
      if (req.method === "OPTIONS") {
        this.sendJson(res, 204, {});
        return;
      }
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method === "GET" && pathname === "/api/clients") {
        // The listener is opened before the zone finishes loading nav/world
        // data.  Do not let the launcher mistake that early listener for a
        // playable server; the readiness bit is the same gate used by the
        // login path for incoming clients.
        if (!this.zone._ready) {
          this.sendJson(res, 503, { ready: false, clients: [] });
          return;
        }
        this.sendJson(res, 200, { ready: true, clients: this.clients() });
        return;
      }
      if (req.method === "GET" && pathname === "/api/npcs") {
        this.sendJson(res, 200, this.tests.status());
        return;
      }
      if (req.method === "POST" && pathname === "/api/god") {
        const body = await this.readJson(req);
        const client = this.soleClient();
        const requested = body.enabled;
        const enabled =
          requested === undefined
            ? !client.character.isGodMode()
            : requested === true || String(requested).toLowerCase() === "true";
        this.zone.setGodMode(client, enabled);
        this.zone.updateCharacterState(
          client,
          client.character.characterId,
          client.character.characterStates,
          true
        );
        this.sendJson(res, 200, {
          enabled: client.character.isGodMode(),
          characterId: client.character.characterId
        });
        return;
      }
      if (req.method === "POST" && pathname === "/api/npc-packet") {
        const body = await this.readJson(req);
        const client = this.soleClient();
        const packet = String(body.packet ?? "");
        if (packet !== "Character.SetComboState") {
          throw new Error("packet must be Character.SetComboState");
        }
        const status = this.tests.status() as { lastNpcId?: string | null };
        const last = status.lastNpcId;
        const requestedId = String(body.characterId ?? "test");
        const characterId = requestedId === "test" ? last : requestedId;
        if (!characterId) throw new Error("no active test NPC");
        const unknownByte1 = Number(body.unknownByte1 ?? 1);
        if (!Number.isInteger(unknownByte1) || unknownByte1 < 0 || unknownByte1 > 255) {
          throw new Error("unknownByte1 must be an integer in [0,255]");
        }
        const data = {
          characterId,
          unknownByte1
        };
        this.zone.sendDataToAllWithSpawnedEntity(
          this.zone._npcs,
          characterId,
          packet,
          data as any
        );
        this.sendJson(res, 200, {
          ok: true,
          packet,
          characterId,
          unknownByte1,
          target: client.character.characterId
        });
        return;
      }
      if (req.method === "POST" && pathname === "/api/respawn") {
        const body = await this.readJson(req);
        const client = this.soleClient();
        const requestedPosition = body.position;
        const currentPosition = Array.from(client.character.state.position).slice(0, 3);
        const position =
          requestedPosition === undefined
            ? currentPosition
            : requestedPosition;
        if (
          !Array.isArray(position) ||
          position.length !== 3 ||
          !position.every(
            (value) => typeof value === "number" && Number.isFinite(value)
          )
        ) {
          throw new Error("position must be a finite [x,y,z] array");
        }
        const spawnPosition = new Float32Array([
          position[0],
          position[1],
          position[2],
          1
        ]);
        this.zone.respawnPlayer(client, spawnPosition, false);
        // This endpoint is a local test reset, not the networked death-screen
        // flow.  The client is already rendering the world when it reaches
        // this handler, so complete the release gate here; otherwise a test
        // animal can chase the player while NPC damage is deliberately
        // rejected as "client isLoading" and the result is misleading.
        client.characterReleased = true;
        client.isLoading = false;
        this.sendJson(res, 200, {
          characterId: client.character.characterId,
          isAlive: client.character.isAlive,
          isRespawning: client.character.isRespawning,
          isLoading: client.isLoading,
          position: Array.from(client.character.state.position)
        });
        return;
      }
      if (req.method === "POST" && pathname === "/api/tp") {
        const body = await this.readJson(req);
        const position = body.position;
        if (
          !Array.isArray(position) ||
          position.length !== 3 ||
          !position.every((value) => typeof value === "number" && Number.isFinite(value))
        ) {
          throw new Error("position must be a finite [x,y,z] array");
        }
        const client = this.soleClient();
        // Reuse the production moderator command path so the client receives
        // the same loading/managed-object handoff as an in-game /tp command.
        // `tp` is a chat command (not an internal command); executeInternal-
        // Command would silently route it to the wrong registry.
        this.zone.commandHandler.executeCommand(this.zone, client, {
          data: {
            commandHash: flhash("TP"),
            arguments: position.map((value) => String(value)).join(" ")
          }
        } as any);
        this.sendJson(res, 200, {
          characterId: client.character.characterId,
          position: Array.from(client.character.state.position),
          isLoading: client.isLoading
        });
        return;
      }
      if (
        req.method === "POST" &&
        (pathname === "/api/animal-test" || pathname === "/api/ztest")
      ) {
        const body = await this.readJson(req);
        const command = String(body.command ?? "status").toLowerCase();
        if (command === "stop") {
          this.sendJson(res, 200, { removed: this.tests.stop() });
          return;
        }
        if (command === "status") {
          this.sendJson(res, 200, this.tests.status());
          return;
        }
        if (command === "hunt" || command === "hunting") {
          const rabbits = Number(body.rabbits ?? 3);
          const deer = Number(body.deer ?? 3);
          const arrows = Number(body.arrows ?? 100);
          const result = this.tests.spawnHunt(
            this.soleClient(),
            rabbits,
            deer,
            arrows
          );
          this.sendJson(res, 200, { ...result, status: this.tests.status() });
          return;
        }
        if (command !== "flat" && command !== "slope") {
          throw new Error("command must be flat, slope, hunt, stop or status");
        }
        const type = String(body.type ?? "zombie").toLowerCase() as AnimalTestType;
        const distance = Number(body.distance ?? 8);
        const height = Number(body.height ?? (command === "slope" ? 1 : 0));
        const result = this.tests.spawn(
          this.soleClient(),
          type,
          distance,
          height,
          command === "flat"
        );
        this.sendJson(res, 200, { command, ...result, status: this.tests.status() });
        return;
      }
      this.sendJson(res, 404, { error: "not found" });
    } catch (error) {
      this.sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
