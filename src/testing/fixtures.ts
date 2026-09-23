import type { SparkSnapshot, SensorMetrics } from "../api/types";

export function makeSpark(id = "spark-1", online = true): SparkSnapshot {
  return {
    id,
    name: `Spark ${id}`,
    kind: "spark",
    online,
    uptime: online ? 100 : null,
    role: "standalone",
    workerNode: false,
    llmMonitoring: true,
    comfyMonitoring: false,
    tailscaleMonitoring: false,
    llmPort: 8888,
    llmPorts: [8888],
    disabledDevices: [],
    disabledInterfaces: [],
    hermes: {
      monitoring: false,
      installed: null,
      version: null,
      updateAvailable: null,
      behindCommits: null,
      checkedAt: null,
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
    },
    hardware: {
      device: "NVIDIA DGX Spark",
      cpuModel: "fixture",
      cpuCores: 20,
      totalMemoryGB: 128,
      gpuChip: "GB10",
      cudaDriver: null,
      storageModel: null,
    },
    metrics: {
      gpu: online ? {
        usage: 42,
        temperature: 55,
        vram: { used: 1024, total: 4096, available: 3072, percentage: 25 },
        power: { draw: 50, limit: 100 },
      } : null,
      cpu: online ? { usage: 25, temperature: 45 } : null,
      ram: online ? { used: 2048, total: 8192, available: 6144, percentage: 25 } : null,
      storage: [],
      network: null,
      unifiedMemory: null,
      sensors: null,
      llm: online ? [{
        available: true,
        backend: "vllm",
        modelId: "fixture-model",
        generationTps: 20,
        prefillTps: 200,
      }] : [],
      comfy: null,
      tailscale: null,
    },
  } as unknown as SparkSnapshot;
}

/**
 * Sensor inventory matching the production PVE host (NCT6799 + k10temp + two
 * NVMe + the 10 GbE NIC + the iGPU), already stripped of unconnected readings
 * the way the collector serves it.
 */
export function makeSensors(): SensorMetrics {
  return {
    available: true,
    reason: null,
    cpu: { key: "Tctl", label: "Tctl", temperature: 76.3 },
    board: [
      { key: "SYSTIN", label: "SYSTIN", temperature: 38 },
      { key: "CPUTIN", label: "CPUTIN", temperature: 48 },
      { key: "PECI/TSI Agent 0 Calibration", label: "PECI/TSI Agent 0 Calibration", temperature: 65 },
      { key: "TSI0_TEMP", label: "TSI0_TEMP", temperature: 76.4 },
    ],
    fans: [
      { key: "fan2", label: "fan2", rpm: 2760, pwmPercent: 70 },
      { key: "fan3", label: "fan3", rpm: 1293, pwmPercent: 87 },
    ],
    disks: [
      { key: "nvme0", label: "ZHITAI Ti600 1TB", temperature: 38.9 },
      { key: "nvme1", label: "ZHITAI TiPro9000 2TB", temperature: 44.9 },
    ],
    nics: [
      { key: "enp10s0 PHY Temperature", label: "PHY Temperature", nicName: "enp10s0", temperature: 56 },
    ],
    igpu: { key: "edge", label: "edge", temperature: 46 },
  };
}

/** A host whose hwmon tree is missing (virtual machine). */
export function makeEmptySensors(reason = "no-sensors"): SensorMetrics {
  return {
    available: false,
    reason,
    cpu: null,
    board: [],
    fans: [],
    disks: [],
    nics: [],
    igpu: null,
  };
}
