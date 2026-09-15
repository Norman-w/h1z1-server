# NavData (z1.bin)

将 `z1.bin` 放在此目录后，在 ZoneServer 中取消注释 `await this.navManager.loadNav()` 即可加载导航网格。

**生成 z1.bin：**

1. 使用同级仓库 **h1z1-nav-extract** 从 H1EMU 客户端资源导出 Z1 地形 OBJ，合并为 `merged_geometry.bin`（不加 `--max-tris` 以得到完整 Z1 几何，否则生成的文件可能过小）。
2. 在项目根目录执行：
   ```bash
   node scripts/build-z1-nav.mjs [merged_geometry.bin] [本目录/z1.bin]
   ```
   几何会先展开为「三角形汤」；超过约 5000 三角形会直接用 Tiled（避免 Solo 的 WASM 越界），否则先试 Solo 再回退 Tiled。完整 Z1（约 1282 万三角形）可能需 30 分钟以上，可加 `node --max-old-space-size=8192` 提高内存。
3. 可选：`--max-tris=N` 仅用前 N 个三角形（测试用）；`--debug` 在 Solo 失败时打印中间 poly 统计。

4. **（推荐大地图）C++ 工具**：项目内提供基于 Recast/Detour 的 C++ 生成器，适合完整 Z1（约 1282 万三角形），无 Node WASM 限制。需先安装 CMake 与 C++ 编译器，然后：
   ```bash
   cd tools/build-z1-nav-cpp
   cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --config Release
   build/Release/build-z1-nav.exe [merged_geometry.bin] [本目录/z1.bin]
   ```
   详见 `tools/build-z1-nav-cpp/README.md`。

若 Node 方案不可用或完整 Z1 构建过慢，也可用 [recastnavigation](https://github.com/recastnavigation/recastnavigation) 的 RecastDemo：在 h1z1-nav-extract 中执行 `python merge_obj.py --obj` 会同时生成 `out/merged.obj`，用 RecastDemo 加载该 OBJ、烘焙 NavMesh 并导出为 Detour bin，重命名为 `z1.bin` 放入本目录。

当前目录下若已有 `z1.bin`（包括仅 40 字节的占位），`importNavMesh` 可正常加载；覆盖为 RecastDemo 导出的完整 bin 即可获得全图寻路。

若暂无 z1.bin，保持 `loadNav()` 注释即可，服务器可正常运行，仅无 NavMesh 寻路。
