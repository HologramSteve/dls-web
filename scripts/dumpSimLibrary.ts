// Writes the simulation library (builtin chips + the original's MainTest project chips) as SimChipDesc JSON,
// used by the Rust engine's native tests and benchmarks. Run: npx vite-node scripts/dumpSimLibrary.ts
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Serializer } from "../src/dls/description/Serializer";
import { CreateAllBuiltinChipDescriptions } from "../src/dls/game/BuiltinChipCreator";
import { ToSimDesc } from "../src/dls/simulation/SimHost";

const chipsDir = join(__dirname, "../testdata/Projects/MainTest/Chips");
const descs = CreateAllBuiltinChipDescriptions().map(ToSimDesc);
for (const f of readdirSync(chipsDir).sort()) descs.push(ToSimDesc(Serializer.DeserializeChipDescription(readFileSync(join(chipsDir, f), "utf8"))));
const out = join(__dirname, "../rust/dls-sim/testdata/maintest_lib.json");
writeFileSync(out, JSON.stringify(descs));
console.log(`Wrote ${descs.length} chip descriptions to ${out}`);
