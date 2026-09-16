import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "vendor/libpaulstretch");
const build = resolve(source, "build-native");
const backend = process.env.PAULSTRETCH_FFT_BACKEND ?? (process.platform === "darwin" ? "ACCELERATE" : "PFFFT");

await mkdir(build, { recursive: true });

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)));
  });
}

await run("cmake", [
  "-S", source,
  "-B", build,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DPAULSTRETCH_BUILD_WASM=OFF",
  "-DPAULSTRETCH_BUILD_TESTS=ON",
  `-DPAULSTRETCH_FFT_BACKEND=${backend}`,
]);
await run("cmake", ["--build", build, "--parallel"]);
console.log(`Built ${resolve(build, process.platform === "win32" ? "paulstretch.exe" : "paulstretch")}`);
