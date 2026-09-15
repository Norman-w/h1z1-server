/**
 * Build z1.bin from merged_geometry.bin using Recast/Detour (C++).
 * Same input format as scripts/build-z1-nav.mjs; output compatible with recast-navigation importNavMesh().
 *
 * Usage: build-z1-nav [input.bin] [output.bin]
 * Default: ../h1z1-nav-extract/out/merged_geometry.bin -> ../../data/2016/navData/z1.bin
 */

#include <Recast.h>
#include <DetourNavMesh.h>
#include <DetourNavMeshBuilder.h>
#include <DetourAlloc.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <string>

#ifdef _WIN32
#include <direct.h>
static int mkdirRecursive(const char* path) {
  char buf[1024];
  strncpy(buf, path, sizeof(buf) - 1);
  buf[sizeof(buf)-1] = '\0';
  for (char* p = buf + 1; *p; p++) {
    if (*p == '/' || *p == '\\') {
      *p = '\0';
      _mkdir(buf);
      *p = '/';
    }
  }
  return _mkdir(buf);
}
#else
#include <sys/stat.h>
static int mkdirRecursive(const char* path) {
  char buf[1024];
  strncpy(buf, path, sizeof(buf) - 1);
  buf[sizeof(buf)-1] = '\0';
  for (char* p = buf + 1; *p; p++) {
    if (*p == '/') {
      *p = '\0';
      mkdir(buf, 0755);
      *p = '/';
    }
  }
  return mkdir(buf, 0755);
}
#endif

static bool readMergedGeometry(const char* path, std::vector<float>& positions, std::vector<int>& indices, unsigned int maxTris = 0) {
  FILE* f = fopen(path, "rb");
  if (!f) {
    fprintf(stderr, "Cannot open input: %s\n", path);
    return false;
  }

  uint32_t nVerts, nIndices;
  if (fread(&nVerts, 4, 1, f) != 1 || fread(&nIndices, 4, 1, f) != 1) {
    fclose(f);
    fprintf(stderr, "Failed to read header\n");
    return false;
  }
  // little-endian assumed (same as Node script)
  // optional: swap if big-endian

  positions.resize(nVerts * 3);
  if (fread(positions.data(), sizeof(float), nVerts * 3, f) != nVerts * 3) {
    fclose(f);
    fprintf(stderr, "Failed to read positions\n");
    return false;
  }

  std::vector<uint32_t> idx(nIndices);
  if (fread(idx.data(), 4, nIndices, f) != nIndices) {
    fclose(f);
    fprintf(stderr, "Failed to read indices\n");
    return false;
  }
  fclose(f);

  if (maxTris > 0 && (nIndices / 3) > maxTris) {
    nIndices = maxTris * 3;
    idx.resize(nIndices);
    fprintf(stderr, "Capped to %u triangles\n", maxTris);
  }

  // Expand to triangle soup: one position per triangle vertex
  std::vector<float> expanded(nIndices * 3);
  for (size_t i = 0; i < nIndices; i++) {
    size_t j = idx[i] * 3;
    expanded[i * 3]     = positions[j];
    expanded[i * 3 + 1] = positions[j + 1];
    expanded[i * 3 + 2] = positions[j + 2];
  }
  positions = std::move(expanded);

  indices.resize(nIndices);
  for (size_t i = 0; i < nIndices; i++)
    indices[i] = static_cast<int>(i);

  fprintf(stderr, "Positions (expanded): %zu  Triangles: %zu\n", positions.size() / 3, indices.size() / 3);
  return true;
}

static void getBounds(const float* verts, int nv, float* bmin, float* bmax) {
  rcVcopy(bmin, verts);
  rcVcopy(bmax, verts);
  for (int i = 1; i < nv; i++) {
    const float* v = verts + i * 3;
    if (v[0] < bmin[0]) bmin[0] = v[0];
    if (v[1] < bmin[1]) bmin[1] = v[1];
    if (v[2] < bmin[2]) bmin[2] = v[2];
    if (v[0] > bmax[0]) bmax[0] = v[0];
    if (v[1] > bmax[1]) bmax[1] = v[1];
    if (v[2] > bmax[2]) bmax[2] = v[2];
  }
}

int main(int argc, char** argv) {
  const char* inputPath  = nullptr;
  const char* outputPath = nullptr;
  unsigned int maxTris   = 0;

  for (int i = 1; i < argc; i++) {
    if (strncmp(argv[i], "--max-tris=", 11) == 0) {
      maxTris = static_cast<unsigned int>(atoi(argv[i] + 11));
    } else if (!inputPath) {
      inputPath = argv[i];
    } else if (!outputPath) {
      outputPath = argv[i];
    }
  }

  if (!inputPath)  inputPath  = "../../../h1z1-nav-extract/out/merged_geometry.bin";  // from tools/build-z1-nav-cpp, repo root is ../..
  if (!outputPath) outputPath = "../../data/2016/navData/z1.bin";                     // from tools/build-z1-nav-cpp

  std::vector<float> positions;
  std::vector<int> indices;
  if (!readMergedGeometry(inputPath, positions, indices, maxTris)) {
    return 1;
  }

  const float* verts = positions.data();
  const int nv       = static_cast<int>(positions.size() / 3);
  const int* tris    = indices.data();
  const int nt       = static_cast<int>(indices.size() / 3);

  rcContext ctx;

  rcConfig config;
  memset(&config, 0, sizeof(config));
  config.cs                  = 1.0f;
  config.ch                   = 0.5f;
  config.walkableSlopeAngle   = 45.0f;
  config.walkableHeight       = static_cast<int>(ceilf(2.0f / config.ch));
  config.walkableClimb        = static_cast<int>(floorf(0.5f / config.ch));
  config.walkableRadius      = static_cast<int>(ceilf(0.5f / config.cs));
  config.maxEdgeLen          = static_cast<int>(12.0f / config.cs);
  config.maxSimplificationError = 1.4f;
  config.minRegionArea       = static_cast<int>(rcSqr(8));
  config.mergeRegionArea     = static_cast<int>(rcSqr(20));
  config.maxVertsPerPoly     = 6;
  config.detailSampleDist    = config.cs * 6.0f;
  config.detailSampleMaxError = config.ch * 1.0f;

  getBounds(verts, nv, config.bmin, config.bmax);
  const int maxDim = 2048;  // 512=coarse/safe, 2048=balanced, 8192=full res (may OOM on huge mesh)
  while (1) {
    rcCalcGridSize(config.bmin, config.bmax, config.cs, &config.width, &config.height);
    if (config.width <= maxDim && config.height <= maxDim) break;
    config.cs *= 2.0f;
    config.ch = config.cs * 0.5f;
    config.walkableHeight = static_cast<int>(ceilf(2.0f / config.ch));
    config.walkableClimb = static_cast<int>(floorf(0.5f / config.ch));
    config.walkableRadius = static_cast<int>(ceilf(0.5f / config.cs));
    config.maxEdgeLen = static_cast<int>(12.0f / config.cs);
    config.detailSampleDist = config.cs * 6.0f;
    config.detailSampleMaxError = config.ch * 1.0f;
  }
  fprintf(stderr, "Building NavMesh (%d x %d cells, cs=%.2f, %d tris)...\n", config.width, config.height, config.cs, nt);

  rcHeightfield* heightfield = rcAllocHeightfield();
  if (!heightfield) {
    fprintf(stderr, "Out of memory: heightfield\n");
    return 1;
  }
  if (!rcCreateHeightfield(&ctx, *heightfield, config.width, config.height, config.bmin, config.bmax, config.cs, config.ch)) {
    fprintf(stderr, "Could not create heightfield\n");
    rcFreeHeightField(heightfield);
    return 1;
  }

  std::vector<unsigned char> triAreas(nt, 0);
  rcMarkWalkableTriangles(&ctx, config.walkableSlopeAngle, verts, nv, tris, nt, triAreas.data());
  if (!rcRasterizeTriangles(&ctx, verts, nv, tris, triAreas.data(), nt, *heightfield, config.walkableClimb)) {
    fprintf(stderr, "Could not rasterize triangles\n");
    rcFreeHeightField(heightfield);
    return 1;
  }

  rcFilterLowHangingWalkableObstacles(&ctx, config.walkableClimb, *heightfield);
  rcFilterLedgeSpans(&ctx, config.walkableHeight, config.walkableClimb, *heightfield);
  rcFilterWalkableLowHeightSpans(&ctx, config.walkableHeight, *heightfield);

  rcCompactHeightfield* compactHeightfield = rcAllocCompactHeightfield();
  if (!compactHeightfield) {
    fprintf(stderr, "Out of memory: chf\n");
    rcFreeHeightField(heightfield);
    return 1;
  }
  if (!rcBuildCompactHeightfield(&ctx, config.walkableHeight, config.walkableClimb, *heightfield, *compactHeightfield)) {
    fprintf(stderr, "Could not build compact heightfield\n");
    rcFreeCompactHeightfield(compactHeightfield);
    rcFreeHeightField(heightfield);
    return 1;
  }
  rcFreeHeightField(heightfield);
  heightfield = nullptr;

  if (!rcErodeWalkableArea(&ctx, config.walkableRadius, *compactHeightfield)) {
    fprintf(stderr, "Could not erode\n");
    rcFreeCompactHeightfield(compactHeightfield);
    return 1;
  }

  if (!rcBuildRegionsMonotone(&ctx, *compactHeightfield, 0, config.minRegionArea, config.mergeRegionArea)) {
    fprintf(stderr, "Could not build regions\n");
    rcFreeCompactHeightfield(compactHeightfield);
    return 1;
  }

  rcContourSet* contourSet = rcAllocContourSet();
  if (!contourSet) {
    fprintf(stderr, "Out of memory: cset\n");
    rcFreeCompactHeightfield(compactHeightfield);
    return 1;
  }
  if (!rcBuildContours(&ctx, *compactHeightfield, config.maxSimplificationError, config.maxEdgeLen, *contourSet)) {
    fprintf(stderr, "Could not build contours\n");
    rcFreeContourSet(contourSet);
    rcFreeCompactHeightfield(compactHeightfield);
    return 1;
  }

  rcPolyMesh* polyMesh = rcAllocPolyMesh();
  if (!polyMesh) {
    fprintf(stderr, "Out of memory: pmesh\n");
    rcFreeContourSet(contourSet);
    rcFreeCompactHeightfield(compactHeightfield);
    return 1;
  }
  if (!rcBuildPolyMesh(&ctx, *contourSet, config.maxVertsPerPoly, *polyMesh)) {
    fprintf(stderr, "Could not build poly mesh\n");
    rcFreePolyMesh(polyMesh);
    rcFreeContourSet(contourSet);
    rcFreeCompactHeightfield(compactHeightfield);
    return 1;
  }

  rcPolyMeshDetail* detailMesh = rcAllocPolyMeshDetail();
  if (!detailMesh) {
    fprintf(stderr, "Out of memory: pmdtl\n");
    rcFreePolyMesh(polyMesh);
    rcFreeContourSet(contourSet);
    rcFreeCompactHeightfield(compactHeightfield);
    return 1;
  }
  if (!rcBuildPolyMeshDetail(&ctx, *polyMesh, *compactHeightfield, config.detailSampleDist, config.detailSampleMaxError, *detailMesh)) {
    fprintf(stderr, "Could not build detail mesh\n");
    rcFreePolyMeshDetail(detailMesh);
    rcFreePolyMesh(polyMesh);
    rcFreeContourSet(contourSet);
    rcFreeCompactHeightfield(compactHeightfield);
    return 1;
  }

  rcFreeCompactHeightfield(compactHeightfield);
  rcFreeContourSet(contourSet);
  compactHeightfield = nullptr;
  contourSet         = nullptr;

  // Poly flags: mark walkable as walk
  const unsigned char WALK = 1;
  for (int i = 0; i < polyMesh->npolys; i++) {
    if (polyMesh->areas[i] == RC_WALKABLE_AREA)
      polyMesh->areas[i] = 0; // ground
    polyMesh->flags[i] = WALK;
  }

  dtNavMeshCreateParams params;
  memset(&params, 0, sizeof(params));
  params.verts         = polyMesh->verts;
  params.vertCount     = polyMesh->nverts;
  params.polys         = polyMesh->polys;
  params.polyAreas     = polyMesh->areas;
  params.polyFlags     = polyMesh->flags;
  params.polyCount     = polyMesh->npolys;
  params.nvp           = polyMesh->nvp;
  params.detailMeshes  = detailMesh->meshes;
  params.detailVerts  = detailMesh->verts;
  params.detailVertsCount = detailMesh->nverts;
  params.detailTris   = detailMesh->tris;
  params.detailTriCount  = detailMesh->ntris;
  params.walkableHeight  = 2.0f;
  params.walkableRadius  = 0.5f;
  params.walkableClimb    = 0.5f;
  rcVcopy(params.bmin, polyMesh->bmin);
  rcVcopy(params.bmax, polyMesh->bmax);
  params.cs           = config.cs;
  params.ch           = config.ch;
  params.buildBvTree  = true;

  fprintf(stderr, "PolyMesh: %d verts, %d polys; Detail: %d verts, %d tris\n",
    polyMesh->nverts, polyMesh->npolys, detailMesh->nverts, detailMesh->ntris);
  if (polyMesh->npolys == 0) {
    fprintf(stderr, "No polygons in poly mesh (try larger geometry or smaller walkableRadius)\n");
    rcFreePolyMeshDetail(detailMesh);
    rcFreePolyMesh(polyMesh);
    return 1;
  }

  unsigned char* navData = nullptr;
  int navDataSize        = 0;
  if (!dtCreateNavMeshData(&params, &navData, &navDataSize)) {
    fprintf(stderr, "Could not build Detour navmesh data\n");
    rcFreePolyMeshDetail(detailMesh);
    rcFreePolyMesh(polyMesh);
    return 1;
  }

  rcFreePolyMeshDetail(detailMesh);
  rcFreePolyMesh(polyMesh);

  // Ensure output directory exists
  std::string out(outputPath);
  size_t last = out.find_last_of("/\\");
  if (last != std::string::npos) {
    std::string dir = out.substr(0, last);
    mkdirRecursive(dir.c_str());
  }

  FILE* outFile = fopen(outputPath, "wb");
  if (!outFile) {
    fprintf(stderr, "Cannot write output: %s\n", outputPath);
    dtFree(navData);
    return 1;
  }
  if (fwrite(navData, 1, navDataSize, outFile) != static_cast<size_t>(navDataSize)) {
    fprintf(stderr, "Failed to write full nav data\n");
    fclose(outFile);
    dtFree(navData);
    return 1;
  }
  fclose(outFile);
  dtFree(navData);

  fprintf(stderr, "Wrote %s | size: %d bytes\n", outputPath, navDataSize);
  return 0;
}
