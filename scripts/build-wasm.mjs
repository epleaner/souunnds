import { copyFile, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "vendor/libpaulstretch");
const build = resolve(source, "build-wasm");
const generated = resolve(source, "npm/dist");
const publicDir = resolve(root, "public/paulstretch");

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

await rm(build, { recursive: true, force: true });
await mkdir(publicDir, { recursive: true });

await run("emcmake", [
  "cmake", "-S", source, "-B", build,
  "-DPAULSTRETCH_BUILD_WASM=ON",
  "-DPAULSTRETCH_BUILD_EXAMPLES=OFF",
  "-DPAULSTRETCH_BUILD_TESTS=OFF",
  "-DPAULSTRETCH_ENABLE_SIMD=ON",
]);
await run("cmake", ["--build", build, "--parallel"]);
await copyFile(resolve(generated, "paulstretch.js"), resolve(publicDir, "paulstretch.js"));
await copyFile(resolve(generated, "paulstretch.wasm"), resolve(publicDir, "paulstretch.wasm"));

await rm(build, { recursive: true, force: true });
await run("emcmake", [
  "cmake", "-S", source, "-B", build,
  "-DPAULSTRETCH_BUILD_WASM=ON",
  "-DPAULSTRETCH_BUILD_EXAMPLES=OFF",
  "-DPAULSTRETCH_BUILD_TESTS=OFF",
  "-DPAULSTRETCH_ENABLE_SIMD=OFF",
]);
await run("cmake", ["--build", build, "--parallel"]);
await copyFile(resolve(generated, "paulstretch.wasm"), resolve(publicDir, "paulstretch.nosimd.wasm"));
console.log(`Built upstream WASM renderer in ${publicDir}`);
