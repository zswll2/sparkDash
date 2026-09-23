import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SystemCollector } from "../SystemCollector.js";
import { HOST_PATHS } from "../../config.js";

/**
 * Verbatim dump from the production PVE host (192.168.1.254, ASUS ProArt
 * X870E + NCT6799D-R), captured by `_buildSensorsCommand()`. Keeping a real
 * capture in the test is deliberate: chip naming, empty AUXTIN inputs, the
 * -60 °C unconnected thermistor, 0 °C PCH internals and empty fan headers are
 * exactly the shapes a hand-written fixture tends to leave out.
 */
const PVE_DUMP = [
  "HWMON|/sys/class/hwmon/hwmon0|enp10s0|net|0000:0a:00.0",
  "TEMP|/sys/class/hwmon/hwmon0|temp1|PHY Temperature|56000",
  "TEMP|/sys/class/hwmon/hwmon0|temp2|MAC Temperature|56000",
  "HWMON|/sys/class/hwmon/hwmon1|nvme|disk|nvme0",
  "TEMP|/sys/class/hwmon/hwmon1|temp1|Composite|38850",
  "TEMP|/sys/class/hwmon/hwmon1|temp2|Sensor 1|38850",
  "TEMP|/sys/class/hwmon/hwmon1|temp3|Sensor 2|41850",
  "HWMON|/sys/class/hwmon/hwmon2|nvme|disk|nvme1",
  "TEMP|/sys/class/hwmon/hwmon2|temp1|Composite|44850",
  "TEMP|/sys/class/hwmon/hwmon2|temp2|Sensor 1|57850",
  "TEMP|/sys/class/hwmon/hwmon2|temp3|Sensor 2|44850",
  "HWMON|/sys/class/hwmon/hwmon3|k10temp|cpu|0000:00:18.3",
  "TEMP|/sys/class/hwmon/hwmon3|temp1|Tctl|76125",
  "HWMON|/sys/class/hwmon/hwmon4|asus|other|eeepc-wmi",
  "HWMON|/sys/class/hwmon/hwmon5|amdgpu|igpu|0000:78:00.0",
  "TEMP|/sys/class/hwmon/hwmon5|temp1|edge|46000",
  "HWMON|/sys/class/hwmon/hwmon6|nct6799|board|nct6775.656",
  "TEMP|/sys/class/hwmon/hwmon6|temp10|PCH_CHIP_CPU_MAX_TEMP|0",
  "TEMP|/sys/class/hwmon/hwmon6|temp11|PCH_CHIP_TEMP|0",
  "TEMP|/sys/class/hwmon/hwmon6|temp12|PCH_CPU_TEMP|0",
  "TEMP|/sys/class/hwmon/hwmon6|temp13|TSI0_TEMP|76375",
  "TEMP|/sys/class/hwmon/hwmon6|temp1|SYSTIN|38000",
  "TEMP|/sys/class/hwmon/hwmon6|temp2|CPUTIN|48000",
  "TEMP|/sys/class/hwmon/hwmon6|temp3|AUXTIN0|29000",
  "TEMP|/sys/class/hwmon/hwmon6|temp4|AUXTIN1|22000",
  "TEMP|/sys/class/hwmon/hwmon6|temp5|AUXTIN2|23000",
  "TEMP|/sys/class/hwmon/hwmon6|temp6|AUXTIN3|14000",
  "TEMP|/sys/class/hwmon/hwmon6|temp7|AUXTIN4|25000",
  "TEMP|/sys/class/hwmon/hwmon6|temp8|PECI/TSI Agent 0 Calibration|65000",
  "TEMP|/sys/class/hwmon/hwmon6|temp9|AUXTIN5|-60000",
  "FAN|/sys/class/hwmon/hwmon6|fan1||0",
  "FAN|/sys/class/hwmon/hwmon6|fan2||2732",
  "FAN|/sys/class/hwmon/hwmon6|fan3||1306",
  "FAN|/sys/class/hwmon/hwmon6|fan4||0",
  "FAN|/sys/class/hwmon/hwmon6|fan5||1296",
  "FAN|/sys/class/hwmon/hwmon6|fan6||1310",
  "FAN|/sys/class/hwmon/hwmon6|fan7||0",
  "PWM|/sys/class/hwmon/hwmon6|pwm1|212",
  "PWM|/sys/class/hwmon/hwmon6|pwm2|178",
  "PWM|/sys/class/hwmon/hwmon6|pwm3|222",
  "PWM|/sys/class/hwmon/hwmon6|pwm4|229",
  "PWM|/sys/class/hwmon/hwmon6|pwm5|166",
  "PWM|/sys/class/hwmon/hwmon6|pwm6|189",
  "PWM|/sys/class/hwmon/hwmon6|pwm7|255",
  "DISK|nvme0n1|ZHITAI Ti600 1TB                        ",
  "DISK|nvme1n1|ZHITAI TiPro9000 2TB",
].join("\n");

const collector = new SystemCollector({ id: "pve", kind: "host", isLocal: false });

test("parses the production PVE dump into component groups", () => {
  const sensors = collector._parseSensorsDump(PVE_DUMP);

  assert.equal(sensors.available, true);
  assert.equal(sensors.reason, null);

  // CPU junction reading, one decimal.
  assert.deepEqual(sensors.cpu, { key: "Tctl", label: "Tctl", temperature: 76.1 });

  // Board rows in chip order (temp1…temp13), noise already gone.
  assert.deepEqual(
    sensors.board.map((reading) => reading.key),
    ["SYSTIN", "CPUTIN", "PECI/TSI Agent 0 Calibration", "TSI0_TEMP"]
  );
  assert.equal(sensors.board[0].temperature, 38);

  // Fans: only headers with a fan, with the matching pwm duty (178/255 ≈ 70%).
  assert.deepEqual(
    sensors.fans.map((fan) => [fan.key, fan.rpm, fan.pwmPercent]),
    [
      ["fan2", 2732, 70],
      ["fan3", 1306, 87],
      ["fan5", 1296, 65],
      ["fan6", 1310, 74],
    ]
  );

  // Drives: composite temperature only, labelled with the model (trimmed).
  assert.deepEqual(sensors.disks, [
    { key: "nvme0", label: "ZHITAI Ti600 1TB", temperature: 38.9 },
    { key: "nvme1", label: "ZHITAI TiPro9000 2TB", temperature: 44.9 },
  ]);

  assert.deepEqual(
    sensors.nics.map((reading) => [reading.key, reading.nicName, reading.temperature]),
    [
      ["enp10s0 PHY Temperature", "enp10s0", 56],
      ["enp10s0 MAC Temperature", "enp10s0", 56],
    ]
  );
  assert.deepEqual(sensors.igpu, { key: "edge", label: "edge", temperature: 46 });
});

test("drops unconnected thermistors, chipset internals and empty headers", () => {
  const sensors = collector._parseSensorsDump(PVE_DUMP);
  const keys = [
    ...sensors.board.map((r) => r.key),
    ...sensors.fans.map((f) => f.key),
  ];
  assert.ok(!keys.some((key) => /AUXTIN/i.test(key)), "AUXTIN inputs are floating");
  assert.ok(!keys.some((key) => /PCH_/i.test(key)), "PCH internals read 0 °C");
  assert.ok(!keys.includes("fan1") && !keys.includes("fan4") && !keys.includes("fan7"));
});

test("reports no-sensors when the host exposes no hwmon tree", () => {
  const sensors = collector._parseSensorsDump("");
  assert.equal(sensors.available, false);
  assert.equal(sensors.reason, "no-sensors");
  assert.equal(sensors.cpu, null);
  assert.deepEqual(sensors.fans, []);
});

test("remote collector takes one SSH round trip and parses its output", async () => {
  const host = new SystemCollector({
    id: "pve",
    kind: "host",
    isLocal: false,
    ssh: { host: "192.168.1.254", user: "root", auth: "key" },
  });
  let calls = 0;
  const sensors = await host.collectSensors(async (spark, command) => {
    calls += 1;
    assert.equal(spark.id, "pve");
    assert.match(command, /\/sys\/class\/hwmon\/hwmon\*/);
    assert.match(command, /cat "\$s\/device\/model"/);
    return PVE_DUMP;
  });
  assert.equal(calls, 1, "one command carries the whole inventory");
  assert.equal(sensors.available, true);
  assert.equal(sensors.fans.length, 4);
  assert.equal(sensors.disks[1].label, "ZHITAI TiPro9000 2TB");
});

test("an unreadable target degrades to reason=unreadable, not a crash", async () => {
  const host = new SystemCollector({
    id: "pve",
    kind: "host",
    isLocal: false,
    ssh: { host: "192.168.1.254", user: "root", auth: "key" },
  });
  const sensors = await host.collectSensors(async () => {
    throw new Error("SSH to 192.168.1.254 failed: connection refused");
  });
  assert.equal(sensors.available, false);
  assert.equal(sensors.reason, "unreadable");
});

test("local dump reads the same line format from a sysfs tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-sensors-"));
  const hwmon = path.join(root, "class", "hwmon");
  const board = path.join(hwmon, "hwmon6");
  const cpu = path.join(hwmon, "hwmon3");
  const disk = path.join(hwmon, "hwmon1");
  for (const dir of [board, cpu, disk]) fs.mkdirSync(dir, { recursive: true });
  const write = (file, value) => fs.writeFileSync(path.join(file), `${value}\n`);

  write(path.join(board, "name"), "nct6799");
  write(path.join(board, "temp1_input"), "38000");
  write(path.join(board, "temp1_label"), "SYSTIN");
  write(path.join(board, "temp9_input"), "-60000");
  write(path.join(board, "temp9_label"), "AUXTIN5");
  write(path.join(board, "fan2_input"), "2732");
  write(path.join(board, "fan4_input"), "0");
  write(path.join(board, "pwm2"), "178");
  write(path.join(cpu, "name"), "k10temp");
  write(path.join(cpu, "temp1_input"), "76125");
  write(path.join(cpu, "temp1_label"), "Tctl");

  // NVMe hwmon: `device` is a symlink to the controller (nvme0), whose block
  // device (nvme0n1) carries the model — same shape as /sys on the host.
  const controller = path.join(root, "nvme", "nvme0");
  const block = path.join(root, "block", "nvme0n1");
  fs.mkdirSync(path.join(block, "device"), { recursive: true });
  fs.mkdirSync(controller, { recursive: true });
  fs.symlinkSync(controller, path.join(disk, "device"));
  write(path.join(disk, "name"), "nvme");
  write(path.join(disk, "temp1_input"), "38850");
  write(path.join(disk, "temp1_label"), "Composite");
  write(path.join(block, "device", "model"), "ZHITAI Ti600 1TB");

  const previousSys = HOST_PATHS.SYS;
  HOST_PATHS.SYS = root;
  try {
    const local = new SystemCollector({ id: "vm100", kind: "host", isLocal: true });
    const sensors = local._parseSensorsDump(local._localSensorsDump());
    assert.equal(sensors.available, true);
    assert.deepEqual(sensors.cpu, { key: "Tctl", label: "Tctl", temperature: 76.1 });
    assert.deepEqual(sensors.board, [{ key: "SYSTIN", label: "SYSTIN", temperature: 38 }]);
    assert.deepEqual(sensors.fans, [{ key: "fan2", label: "fan2", rpm: 2732, pwmPercent: 70 }]);
    assert.deepEqual(sensors.disks, [
      { key: "nvme0", label: "ZHITAI Ti600 1TB", temperature: 38.9 },
    ]);
  } finally {
    HOST_PATHS.SYS = previousSys;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
