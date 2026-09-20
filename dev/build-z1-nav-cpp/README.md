# C++ 版 z1.bin 生成工具

使用 Recast/Detour（C++）从 `merged_geometry.bin` 生成与 `recast-navigation` 的 `importNavMesh()` 兼容的 `z1.bin`。适合完整 Z1 大地图（约 1282 万三角形），可避免 Node 方案的 WASM 内存与速度限制。

## 依赖

- **CMake** 3.15+（未安装时，运行 `npm run build-z1-nav-cpp` 会自动下载便携版到 `tools/build-z1-nav-cpp/.cmake-portable`）
- **C++14** 编译器：
  - **Windows**：需安装 [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/zh-hans/visual-cpp-build-tools/)（免费），安装时勾选「使用 C++ 的桌面开发」；或完整 Visual Studio / Ninja + MinGW
  - **Linux/macOS**：通常已有 `g++`/`clang++`
- 构建时自动通过 FetchContent 下载 [recastnavigation](https://github.com/recastnavigation/recastnavigation)（需网络与 git）

## 构建

**推荐**：在仓库根目录执行（会自动下载 CMake 并配置、编译）：

```bash
npm run build-z1-nav-cpp
```

或在本目录下手动执行：

```bash
cd tools/build-z1-nav-cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release   # Linux/macOS 或已装 Ninja 的 Windows
cmake --build build --config Release        # Windows 用 VS 时加 --config Release
```

Windows 使用 Visual Studio 时：

```bash
cmake -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

生成的可执行文件：`build/Release/build-z1-nav.exe`（Windows VS）或 `build/build-z1-nav.exe`（Ninja）、或 `build/build-z1-nav`（Unix）。

## 用法

与 Node 脚本相同的输入格式（来自 h1z1-nav-extract 的 `merge_obj.py` 输出的 `merged_geometry.bin`）：

```bash
# 默认：输入 ../h1z1-nav-extract/out/merged_geometry.bin，输出 ../../data/2016/navData/z1.bin
./build/build-z1-nav

# 指定输入和输出
./build/build-z1-nav /path/to/merged_geometry.bin /path/to/z1.bin

# 仅用前 N 个三角形（测试用）
./build/build-z1-nav --max-tris=5000 merged_geometry.bin out/z1.bin
```

## 参数说明

- 第一个非选项参数：输入 `.bin` 路径（merged geometry）
- 第二个非选项参数：输出 `z1.bin` 路径
- `--max-tris=N`：仅使用前 N 个三角形，用于快速测试

## 与 Node 脚本的对应关系

- 使用与 `scripts/build-z1-nav.mjs` 相同的 Recast 参数：`cs=1`，`ch=0.5`，`walkableHeight=2`，`walkableRadius=0.5`，`walkableClimb=0.5`，`walkableSlopeAngle=45`。
- 输出格式为 Detour 单块 NavMesh 二进制，与 `exportNavMesh()` / `importNavMesh()` 兼容。
- 仅实现 Solo 构建（单块 navmesh），不实现 Tiled；对完整 Z1 建议本 C++ 工具或 RecastDemo 离线烘焙。

## 若无法使用 CMake

可改用：

1. **Node 脚本**：`node scripts/build-z1-nav.mjs [input] [output]`（完整 Z1 可能较慢或需 `--max-old-space-size=8192`）。
2. **RecastDemo**：在 [recastnavigation](https://github.com/recastnavigation/recastnavigation) 中打开 RecastDemo，加载 `merged.obj`（h1z1-nav-extract 中 `python merge_obj.py --obj` 生成），烘焙 NavMesh 后导出为 bin，重命名为 `z1.bin` 放入 `data/2016/navData/`。
