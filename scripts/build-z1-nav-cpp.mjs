/**
 * 配置并编译 C++ 版 z1.bin 生成器（若未安装 CMake 会尝试下载便携版）。
 * 用法: node scripts/build-z1-nav-cpp.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const cppDir = path.join(root, "tools", "build-z1-nav-cpp");
const buildDir = path.join(cppDir, "build");

const isWin = process.platform === "win32";
const CMAKE_VERSION = "3.28.1";
const CMAKE_URL_WIN = `https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-windows-x86_64.zip`;
const portableDir = path.join(cppDir, ".cmake-portable");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd || cppDir, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r;
}

function findCmake() {
  const inPath = spawnSync(isWin ? "where" : "which", ["cmake"], { encoding: "utf8" });
  if (inPath.status === 0 && inPath.stdout.trim()) return "cmake";

  const candidates = isWin
    ? [
        path.join(portableDir, `cmake-${CMAKE_VERSION}-windows-x86_64`, "bin", "cmake.exe"),
        path.join(portableDir, "cmake", "bin", "cmake.exe"),
        "C:\\Program Files\\CMake\\bin\\cmake.exe",
        path.join(process.env.LOCALAPPDATA || "", "Programs", "CMake", "bin", "cmake.exe"),
      ]
    : [
        path.join(portableDir, "cmake", "bin", "cmake"),
        "/usr/bin/cmake",
        "/usr/local/bin/cmake",
      ];

  for (const exe of candidates) {
    if (exe && existsSync(exe)) return exe;
  }
  return null;
}

async function downloadPortableCmake() {
  if (!isWin) {
    console.error("未找到 CMake。请安装: sudo apt install cmake (或 brew install cmake)");
    process.exit(1);
  }
  if (existsSync(path.join(portableDir, "cmake", "bin", "cmake.exe"))) {
    return path.join(portableDir, "cmake", "bin", "cmake.exe");
  }
  console.log("正在下载便携版 CMake...");
  mkdirSync(portableDir, { recursive: true });
  const zipPath = path.join(portableDir, "cmake.zip");

  const resp = await fetch(CMAKE_URL_WIN, { redirect: "follow" });
  if (!resp.ok) throw new Error(`下载失败: ${resp.status} ${resp.statusText}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const w = createWriteStream(zipPath);
  await new Promise((resolve, reject) => {
    w.write(buf, (err) => (err ? reject(err) : w.end(resolve)));
    w.on("error", reject);
  });
  await new Promise((resolve, reject) => w.on("finish", resolve).on("error", reject));

  const expand = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Expand-Archive -Path "${zipPath}" -DestinationPath "${portableDir}" -Force`],
    { stdio: "inherit", cwd: cppDir }
  );
  if (expand.status !== 0) {
    console.error("解压失败，请手动解压", zipPath, "到", portableDir);
    process.exit(1);
  }
  const extracted = path.join(portableDir, `cmake-${CMAKE_VERSION}-windows-x86_64`);
  const bin = path.join(extracted, "bin", "cmake.exe");
  if (existsSync(bin)) return bin;
  console.error("解压后未找到 cmake.exe，请检查", portableDir);
  process.exit(1);
}

async function main() {
  let cmakeExe = findCmake();
  if (!cmakeExe) cmakeExe = await downloadPortableCmake();
  console.log("使用 CMake:", cmakeExe);

  mkdirSync(buildDir, { recursive: true });
  const generators = isWin
    ? [
        ["-B", "build", "-G", "Ninja", "-DCMAKE_BUILD_TYPE=Release"],
        ["-B", "build", "-G", "Visual Studio 17 2022", "-A", "x64"],
        ["-B", "build", "-G", "Visual Studio 16 2019", "-A", "x64"],
      ]
    : [["-B", "build", "-DCMAKE_BUILD_TYPE=Release"]];
  let configured = false;
  for (const args of generators) {
    if (existsSync(buildDir)) {
      try { rmSync(buildDir, { recursive: true }); } catch (_) {}
    }
    mkdirSync(buildDir, { recursive: true });
    const r = spawnSync(cmakeExe, args, { stdio: "inherit", cwd: cppDir });
    if (r.status === 0) {
      configured = true;
      break;
    }
  }
  if (!configured) {
    console.error("CMake 配置失败。Windows 下请安装 C++ 构建环境：");
    console.error("  1) 推荐：Visual Studio Build Tools 2022（免费）");
    console.error("     https://visualstudio.microsoft.com/zh-hans/visual-cpp-build-tools/");
    console.error("     安装时勾选「使用 C++ 的桌面开发」。");
    console.error("  2) 或完整 Visual Studio 2022/2019、或 Ninja + MinGW (g++)。");
    process.exit(1);
  }
  const buildConfig = isWin && !process.env.CMAKE_BUILD_PARALLEL_LEVEL ? ["--config", "Release"] : [];
  run(cmakeExe, ["--build", "build", ...buildConfig], { cwd: cppDir });

  const exeCandidates = isWin
    ? [
        path.join(buildDir, "Release", "build-z1-nav.exe"),
        path.join(buildDir, "build-z1-nav.exe"),
      ]
    : [path.join(buildDir, "build-z1-nav")];
  const exe = exeCandidates.find((p) => existsSync(p));
  if (exe) {
    console.log("构建成功:", exe);
  } else {
    console.error("未找到可执行文件，检查:", exeCandidates);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
