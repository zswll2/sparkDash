/**
 * Real-path probe for the new hardware-sensors collector (run on VM100).
 *
 * Drives the deployed collector exactly as SparkMonitor would:
 *  1. PVE (remote, kind=host)  → dump + parsed groups
 *  2. vm100 (local host)       → expect available:false / reason "no-sensors"
 *
 * The raw PVE dump is printed between markers so it can be pasted into the
 * parser unit test as a fixture.
 */
import fs from "node:fs";
import { SystemCollector } from "/www/project/sparkDash/server/collectors/SystemCollector.js";
import { sshExec } from "/www/project/sparkDash/server/collectors/ssh.js";

const config = JSON.parse(fs.readFileSync("/www/project/sparkDash/config/sparks.json", "utf8"));
const byId = (id) => {
  const spark = config.sparks.find((s) => s.id === id);
  if (!spark) throw new Error(`no spark ${id} in config/sparks.json`);
  return spark;
};

const pve = new SystemCollector(byId("pve"));
const dump = await sshExec(byId("pve"), pve._buildSensorsCommand(), { timeoutMs: 8000 });
console.log("=== DUMP START ===");
console.log(dump);
console.log("=== DUMP END ===");
console.log("=== PARSED (pve) ===");
console.log(JSON.stringify(pve._parseSensorsDump(dump), null, 2));

console.log("=== collectSensors (pve) ===");
console.log(JSON.stringify(await pve.collectSensors(), null, 2));

const local = new SystemCollector(byId("vm100"));
console.log("=== collectSensors (vm100 local) ===");
console.log(JSON.stringify(await local.collectSensors(), null, 2));
