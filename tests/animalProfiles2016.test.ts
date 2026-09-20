import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ANIMAL_PROFILE_IDS } from "../out/servers/ZoneServer2016/entities/animalprofiles";

test("animal profile constants point to 2016 profile records, not type numbers", () => {
  const definitions = JSON.parse(
    fs.readFileSync(
      path.resolve(
        process.cwd(),
        "data/2016/dataSources/ServerProfileDefinitions.json"
      ),
      "utf8"
    )
  ).profiles as Array<{
    ID: number;
    profileData: {
      unknownByte1: number;
      unknownDword2: number;
    };
  }>;
  const byId = new Map(definitions.map((profile) => [profile.ID, profile]));
  const summary = (id: number) => {
    const profile = byId.get(id)?.profileData;
    return profile
      ? {
          unknownByte1: profile.unknownByte1,
          unknownDword2: profile.unknownDword2
        }
      : undefined;
  };

  assert.deepEqual(
    {
      deer: summary(ANIMAL_PROFILE_IDS.DEER),
      wolf: summary(ANIMAL_PROFILE_IDS.WOLF),
      bear: summary(ANIMAL_PROFILE_IDS.BEAR),
      rabbit: summary(ANIMAL_PROFILE_IDS.RABBIT)
    },
    {
      deer: { unknownByte1: 22, unknownDword2: 1245 },
      wolf: { unknownByte1: 23, unknownDword2: 1213 },
      bear: { unknownByte1: 24, unknownDword2: 1246 },
      rabbit: { unknownByte1: 26, unknownDword2: 21 }
    }
  );
});
