import { bindings, defineConfig, defineContainer, exports } from "cf/config";

const media = defineContainer({
  name: "epleaner-souunnds-media",
  schedulingPolicy: "durable-object",
  images: { base: { dockerfile: "../../Dockerfile.media" } },
});

export default defineConfig({
  accountId: "8ee70c4b6325ecf3bdc84838281a61f4",
  containers: [media],
  worker: {
    name: "epleaner-souunnds",
    entrypoint: "../../src/worker.mjs",
    compatibilityDate: "2026-10-26",
    compatibilityFlags: ["nodejs_compat", "enable_request_signal", "request_signal_passthrough"],
    workersDev: true,
    domains: ["souunnds.elipleaner.com"],
    assets: { runWorkerFirst: true, notFoundHandling: "single-page-application" },
    env: {
      ASSETS: bindings.assets(),
    },
    exports: { MediaContainer: exports.durableObject({ storage: "sqlite", container: media }) },
  },
});
