import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";

const media = defineContainer({
  name: "epleaner-souunnds-shareable-media",
  schedulingPolicy: "durable-object",
  images: { base: { dockerfile: "../../Dockerfile.media" } },
});

export default defineConfig({
  accountId: "8ee70c4b6325ecf3bdc84838281a61f4",
  containers: [media],
  worker: {
    name: "epleaner-souunnds-shareable",
    entrypoint: "../../src/worker.mjs",
    compatibilityDate: "2026-10-26",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
    workersDev: true,
    domains: ["souunnds-preview.elipleaner.com"],
    assets: { runWorkerFirst: true, notFoundHandling: "single-page-application" },
    triggers: [triggers.scheduled({ schedule: "0 */6 * * *" })],
    env: {
      ASSETS: bindings.assets(),
      DB: bindings.d1({ id: "bfcbd7d8-293e-4e9f-840a-e3d54b5c7a5d", name: "epleaner-souunnds-sharing" }),
      AUDIO: bindings.r2({ name: "epleaner-souunnds-audio" }),
    },
    exports: { MediaContainer: exports.durableObject({ storage: "sqlite", container: media }) },
  },
});
