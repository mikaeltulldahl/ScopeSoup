// Default settings. Every number here is a setting (docs/RULES.md), and the stage 3 rules start off.

import type { MappingRule, QueueConfig } from "./types.ts";

export const defaultMappingRule: MappingRule = {
  testSuffix: "\\.(test|spec|e2e)\\.[cm]?[jt]sx?$",
  sourceSuffix: "\\.[cm]?[jt]sx?$",
  stripPrefix: "",
  featureFolders: ["features"],
  aliases: [],
};

export const defaultConfig: QueueConfig = {
  batch: { min: 2, max: 12, cBisect: 0.7, cMapping: 1.0, pFloor: 0.03, window: 30, minOutcomes: 10, model: true, rerunCost: 0.15 },
  rerunCount: 1,
  reportFileCap: 50,
  maxRunAttempts: 3,
  mapping: { enabled: true, rule: defaultMappingRule },
  onlyWriter: false,
  orderDependence: "report",
  reuseResults: true,
  keepBatches: 20,
  historyLimit: 50,
  knownLimit: 200,
};

/** The defaults with some settings changed. `batch` and `mapping` are merged one level down. */
export function configWith(over: Partial<Omit<QueueConfig, "batch" | "mapping">> & { batch?: Partial<QueueConfig["batch"]>; mapping?: Partial<QueueConfig["mapping"]> }): QueueConfig {
  return {
    ...defaultConfig,
    ...over,
    batch: { ...defaultConfig.batch, ...over.batch },
    mapping: { ...defaultConfig.mapping, ...over.mapping },
  };
}
