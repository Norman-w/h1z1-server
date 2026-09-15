cmake_minimum_required(VERSION 3.15)
project(build-z1-nav CXX)

set(CMAKE_CXX_STANDARD 14)

# RecastNavigation: fetch and build Recast + Detour (no demo/tests)
set(RECASTNAVIGATION_DEMO OFF CACHE BOOL "" FORCE)
set(RECASTNAVIGATION_TESTS OFF CACHE BOOL "" FORCE)
set(RECASTNAVIGATION_EXAMPLES OFF CACHE BOOL "" FORCE)
include(FetchContent)
FetchContent_Declare(
  recastnavigation
  GIT_REPOSITORY https://github.com/recastnavigation/recastnavigation.git
  GIT_TAG        main
)
FetchContent_MakeAvailable(recastnavigation)

# Our executable; use RecastNavigation:: namespace if exported, else bare Recast/Detour
add_executable(build-z1-nav main.cpp)
target_link_libraries(build-z1-nav PRIVATE RecastNavigation::Recast RecastNavigation::Detour)
