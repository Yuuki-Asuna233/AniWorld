cmake_minimum_required(VERSION 3.14)

option(MEDIA_KIT_LIBS_AVAILABLE "package:media_kit libraries are available." ON)

set(PROJECT_NAME "media_kit_libs_windows_video")
project(${PROJECT_NAME} LANGUAGES CXX)

# Export the renderer capability to media_kit_video. The archive is extracted
# by a build target after CMake configure, so checking the header on disk from
# the consumer package would be racy.
set(MEDIA_KIT_LIBS_WINDOWS_HAS_RENDER_DXGI ON CACHE INTERNAL
  "The bundled Windows libmpv exposes the DXGI render API.")

add_compile_definitions(_DISABLE_CONSTEXPR_MUTEX_CONSTRUCTOR)

function(download_and_verify url sha256 locationForArchive)
  if(EXISTS "${locationForArchive}")
    file(SHA256 "${locationForArchive}" ARCHIVE_SHA256)
    if(NOT sha256 STREQUAL ARCHIVE_SHA256)
      file(REMOVE "${locationForArchive}")
    endif()
  endif()
  if(NOT EXISTS "${locationForArchive}")
    message(STATUS "Downloading libmpv archive from ${url}...")
    file(DOWNLOAD "${url}" "${locationForArchive}"
      SHOW_PROGRESS STATUS DOWNLOAD_STATUS TLS_VERIFY ON)
    list(GET DOWNLOAD_STATUS 0 DOWNLOAD_STATUS_CODE)
    if(NOT DOWNLOAD_STATUS_CODE EQUAL 0)
      list(GET DOWNLOAD_STATUS 1 DOWNLOAD_STATUS_MESSAGE)
      message(FATAL_ERROR "Failed to download libmpv archive: ${DOWNLOAD_STATUS_MESSAGE}")
    endif()
    file(SHA256 "${locationForArchive}" ARCHIVE_SHA256)
    if(NOT sha256 STREQUAL ARCHIVE_SHA256)
      message(FATAL_ERROR "libmpv archive checksum mismatch: ${locationForArchive}")
    endif()
  endif()
endfunction()

function(check_directory_exists_and_not_empty dir result_var)
  if(EXISTS "${dir}")
    file(GLOB dir_contents "${dir}/*")
    if(dir_contents)
      set(${result_var} TRUE PARENT_SCOPE)
      return()
    endif()
  endif()
  set(${result_var} FALSE PARENT_SCOPE)
endfunction()

string(TOLOWER "${CMAKE_SYSTEM_PROCESSOR}" LIBMPV_TARGET_PROCESSOR)
string(TOLOWER "${CMAKE_GENERATOR_PLATFORM}" LIBMPV_GENERATOR_PLATFORM)
if(LIBMPV_TARGET_PROCESSOR MATCHES "^(arm64|aarch64)$" OR LIBMPV_GENERATOR_PLATFORM MATCHES "^(arm64|aarch64)$")
  set(LIBMPV "mpv-dev-aarch64-20260623-git-ad59ff1.zip")
  set(LIBMPV_SHA256 "381711758315b81d17df24fbb9dc4333b33b840c14fd674e264fb3306d21b7b0")
else()
  set(LIBMPV "mpv-dev-x86_64-20260623-git-ad59ff1.7z")
  set(LIBMPV_SHA256 "159d7379898e2e2490ab3e0dca233daa5b7389fcd32d4cb8c420399f44284399")
endif()

set(LIBMPV_URL "https://github.com/Predidit/libmpv-win32-video-cmake/releases/download/20260623/${LIBMPV}")
set(LIBMPV_ARCHIVE "${CMAKE_BINARY_DIR}/${LIBMPV}")
set(LIBMPV_SRC "${CMAKE_BINARY_DIR}/libmpv")
download_and_verify(${LIBMPV_URL} ${LIBMPV_SHA256} ${LIBMPV_ARCHIVE})
check_directory_exists_and_not_empty(${LIBMPV_SRC} LIBMPV_SRC_VALID)

if(NOT LIBMPV_SRC_VALID)
  make_directory("${LIBMPV_SRC}")
  add_custom_target("${PROJECT_NAME}_LIBMPV_EXTRACT" ALL)
  find_program(TAR_EXECUTABLE tar REQUIRED)
  add_custom_command(
    TARGET "${PROJECT_NAME}_LIBMPV_EXTRACT" POST_BUILD
    # Windows' bundled bsdtar understands both the .7z x64 archive and the
    # .zip arm64 archive. CMake -E tar does not understand .7z on all Flutter
    # toolchains, so invoke tar directly.
    COMMAND "${TAR_EXECUTABLE}" -xf "${LIBMPV_ARCHIVE}"
    # media_kit_video includes the headers without the mpv/ prefix.
    # Use CMake's portable file commands instead of cmd.exe xcopy/rmdir/ren,
    # whose exit codes vary between Windows shells.
    COMMAND "${CMAKE_COMMAND}" -E copy_directory
      "${LIBMPV_SRC}/include/mpv" "${LIBMPV_SRC}/include"
    COMMAND "${CMAKE_COMMAND}" -E remove_directory
      "${LIBMPV_SRC}/include/mpv"
    WORKING_DIRECTORY "${LIBMPV_SRC}"
  )
endif()

set(PLUGIN_NAME "media_kit_libs_windows_video_plugin")
add_library(${PLUGIN_NAME} SHARED
  "include/media_kit_libs_windows_video/media_kit_libs_windows_video_plugin_c_api.h"
  "media_kit_libs_windows_video_plugin_c_api.cpp")
apply_standard_settings(${PLUGIN_NAME})
set_target_properties(${PLUGIN_NAME} PROPERTIES CXX_VISIBILITY_PRESET hidden)
target_compile_definitions(${PLUGIN_NAME} PRIVATE FLUTTER_PLUGIN_IMPL)
target_include_directories(${PLUGIN_NAME} INTERFACE "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_link_libraries(${PLUGIN_NAME} PRIVATE flutter flutter_wrapper_plugin)

set(media_kit_libs_windows_video_bundled_libraries
  "${LIBMPV_SRC}/libmpv-2.dll" PARENT_SCOPE)
