// This file is a part of media_kit
// (https://github.com/media-kit/media-kit).
//
// Copyright © 2021 & onwards, Hitesh Kumar Saini <saini123hitesh@gmail.com>.
// All rights reserved.
// Use of this source code is governed by MIT license that can be found in the
// LICENSE file.

#include "video_output.h"

#include <algorithm>
#include <chrono>

// Limit the frame size to 1080p in software rendering.
// This is for performance reasons & to avoid allocating too much memory.
#define SW_RENDERING_MAX_WIDTH 1920
#define SW_RENDERING_MAX_HEIGHT 1080
#define SW_RENDERING_PIXEL_BUFFER_SIZE \
  (SW_RENDERING_MAX_WIDTH) * (SW_RENDERING_MAX_HEIGHT) * (4)

namespace {
// Fit both dimensions together. Floating point division avoids truncating the
// aspect ratio to zero, and avoids overflow when a caller requests a huge size.
std::pair<int64_t, int64_t> FitSoftwareSize(int64_t width, int64_t height) {
  if (width <= 0 || height <= 0) return {0, 0};
  const auto scale = (std::min)({
      1.0L,
      static_cast<long double>(SW_RENDERING_MAX_WIDTH) / width,
      static_cast<long double>(SW_RENDERING_MAX_HEIGHT) / height,
  });
  return {
      std::clamp(static_cast<int64_t>(width * scale), int64_t{1},
                 int64_t{SW_RENDERING_MAX_WIDTH}),
      std::clamp(static_cast<int64_t>(height * scale), int64_t{1},
                 int64_t{SW_RENDERING_MAX_HEIGHT}),
  };
}
}  // namespace

VideoOutput::VideoOutput(int64_t handle,
                         VideoOutputConfiguration configuration,
                         flutter::PluginRegistrarWindows* registrar,
                         ThreadPool* thread_pool_ref)
    : handle_(reinterpret_cast<mpv_handle*>(handle)),
      width_(configuration.width),
      height_(configuration.height),
      configuration_(configuration),
      registrar_(registrar),
      thread_pool_ref_(thread_pool_ref) {
  frame_notifier_ = std::make_unique<FrameCompletionNotifier>(
      [this] { NotifyCompletedFrame(); });
  // The constructor must be invoked through the thread pool.
  auto future = thread_pool_ref_->Post([&]() {
    mpv_set_option_string(handle_, "video-sync", "audio");
    mpv_set_option_string(handle_, "video-timing-offset", "0");
    
    // Initialize video playback with hardware acceleration using native D3D11.
    auto is_hardware_acceleration_enabled = false;
    
 #if defined(MEDIA_KIT_HAS_RENDER_DXGI)
    if (configuration.enable_hardware_acceleration) {
      try {
        IDXGIAdapter* flutter_adapter = nullptr;
        if (auto* view = registrar_->GetView()) {
          flutter_adapter = view->GetGraphicsAdapter();
        }
        d3d11_renderer_ = std::make_unique<D3D11Renderer>(
            static_cast<int32_t>(width_.value_or(1)),
            static_cast<int32_t>(height_.value_or(1)),
            flutter_adapter);
        
        // Initialize mpv with the D3D11 device and swap chain
        mpv_dxgi_init_params init_params = {
            d3d11_renderer_->device(),
            // Must provide swap chain, not nullptr
            // Otherwise, you will get freeze.
            d3d11_renderer_->swap_chain()
        };
        
        mpv_render_param params[] = {
            {MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_DXGI},
            {MPV_RENDER_PARAM_DXGI_INIT_PARAMS, &init_params},
            {MPV_RENDER_PARAM_INVALID, nullptr},
        };
        
        // Create render context.
        if (mpv_render_context_create(&render_context_, handle_, params) == 0) {
          mpv_render_context_set_update_callback(
              render_context_,
              [](void* context) {
                auto that = reinterpret_cast<VideoOutput*>(context);
                that->NotifyRender();
              },
              reinterpret_cast<void*>(this));
          
          // Now create the Flutter texture after successful render context creation
          Resize(width_.value_or(1), height_.value_or(1));
          
          // Set flag to true, indicating that H/W rendering is supported.
          is_hardware_acceleration_enabled = true;
          std::cout << "media_kit: VideoOutput: Using native D3D11 H/W rendering."
                    << std::endl;
        } else {
          std::cout << "media_kit: VideoOutput: Failed to create mpv render context."
                    << std::endl;
          d3d11_renderer_.reset(nullptr);
        }
      } catch (const std::exception& e) {
        // Fallback to software rendering.
        std::cout << "media_kit: VideoOutput: Failed to initialize D3D11: " 
                  << e.what() << ", falling back to S/W."
                  << std::endl;
        d3d11_renderer_.reset(nullptr);
      } catch (...) {
        // Fallback to software rendering.
        std::cout << "media_kit: VideoOutput: Failed to initialize D3D11, falling back to S/W."
                  << std::endl;
        d3d11_renderer_.reset(nullptr);
      }
    }
 #endif
    
    if (!is_hardware_acceleration_enabled) {
      std::cout << "media_kit: VideoOutput: Using S/W rendering." << std::endl;
      // Allocate a "large enough" buffer ahead of time.
      pixel_buffer_ =
          std::make_unique<uint8_t[]>(SW_RENDERING_PIXEL_BUFFER_SIZE);
      Resize((std::max)(int64_t{1}, width_.value_or(1)),
             (std::max)(int64_t{1}, height_.value_or(1)));
      mpv_render_param params[] = {
          {MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_SW},
          {MPV_RENDER_PARAM_INVALID, nullptr},
      };
      if (mpv_render_context_create(&render_context_, handle_, params) == 0) {
        mpv_render_context_set_update_callback(
            render_context_,
            [](void* context) {
              auto that = reinterpret_cast<VideoOutput*>(context);
              that->NotifyRender();
            },
            reinterpret_cast<void*>(this));
      }
    }
  });
  future.wait();
}

VideoOutput::~VideoOutput() {
  {
    std::lock_guard<std::mutex> lock(render_tasks_mutex_);
    destroyed_ = true;
  }
  // No completion callback may enqueue work after the render queue is drained.
  if (frame_notifier_) frame_notifier_->Stop();
  // Drain queued renders and remove the callback on the render thread.
  // Completion of this destructor is the acknowledgement consumed by Dart.
  thread_pool_ref_->Post([this]() {
    if (render_context_) {
      mpv_render_context_set_update_callback(render_context_, nullptr, nullptr);
      mpv_render_context_free(render_context_);
      render_context_ = nullptr;
    }
  }).get();

  if (texture_id_) UnregisterTexture(texture_id_);
  // Include textures retired during resizing, whose callbacks also use this.
  for (const auto& completion : texture_unregistrations_) completion.get();

  thread_pool_ref_->Post([this]() {
    std::lock_guard<std::mutex> lock(textures_mutex_);
    texture_id_ = 0;
    texture_variants_.clear();
    textures_.clear();
    pixel_buffer_textures_.clear();
    d3d11_renderer_.reset();
    pixel_buffer_.reset();
  }).get();
}

void VideoOutput::NotifyRender() {
  std::lock_guard<std::mutex> lock(render_tasks_mutex_);
  if (destroyed_) {
    return;
  }
  thread_pool_ref_->Post(std::bind(&VideoOutput::CheckAndResize, this));
  thread_pool_ref_->Post(std::bind(&VideoOutput::Render, this));
}

void VideoOutput::Render() {
  if (texture_id_) {
    // H/W
    if (d3d11_renderer_ != nullptr) {
      mpv_render_context_render(render_context_, nullptr);
      mpv_render_context_report_swap(render_context_);
      d3d11_renderer_->ProducerCommit();
      frame_notifier_->Submit(d3d11_renderer_->PendingFence(),
                              d3d11_renderer_->PendingFenceValue());
    }
    // S/W
    if (pixel_buffer_ != nullptr) {
      int32_t size[]{
          static_cast<int32_t>(pixel_buffer_textures_.at(texture_id_)->width),
          static_cast<int32_t>(pixel_buffer_textures_.at(texture_id_)->height),
      };
      auto pitch = 4 * size[0];
      mpv_render_param params[]{
          {MPV_RENDER_PARAM_SW_SIZE, size},
          {MPV_RENDER_PARAM_SW_FORMAT, "rgb0"},
          {MPV_RENDER_PARAM_SW_STRIDE, &pitch},
          {MPV_RENDER_PARAM_SW_POINTER, pixel_buffer_.get()},
          {MPV_RENDER_PARAM_INVALID, nullptr},
      };
      mpv_render_context_render(render_context_, params);
    }
    try {
      // Notify Flutter that a new frame is available.
      registrar_->texture_registrar()->MarkTextureFrameAvailable(texture_id_);
    } catch (...) {
      // Prevent any redundant exceptions if the texture is unregistered etc.
    }
  }
}

void VideoOutput::NotifyCompletedFrame() {
  std::lock_guard<std::mutex> lock(render_tasks_mutex_);
  if (destroyed_) return;
  thread_pool_ref_->Post([this] {
    if (destroyed_ || !texture_id_ || !d3d11_renderer_) return;
    if (d3d11_renderer_->PromoteCompletedFrame()) {
      registrar_->texture_registrar()->MarkTextureFrameAvailable(texture_id_);
    }
  });
}

void VideoOutput::SetTextureUpdateCallback(
    std::function<void(int64_t, int64_t, int64_t)> callback) {
  thread_pool_ref_->Post([this, callback = std::move(callback)]() {
    texture_update_callback_ = callback;
    const auto size = GetVideoSize();
    texture_update_callback_(texture_id_, size.first, size.second);
  }).get();
}

void VideoOutput::SetSize(std::optional<int64_t> width,
                          std::optional<int64_t> height) {
  thread_pool_ref_->Post([&, width, height]() {
    // Keep the requested pair intact; independently clamping each dimension
    // would change its aspect ratio before software size fitting.
    width_ = width;
    height_ = height;
  });
}

void VideoOutput::CheckAndResize() {
  // Check if a new texture with different dimensions is needed.
  const auto size = GetVideoSize();
  const auto required_width = size.first, required_height = size.second;
  if (required_width < 1 || required_height < 1) {
    // Invalid.
    return;
  }
  int64_t current_width = -1, current_height = -1;
  if (d3d11_renderer_ != nullptr) {
    current_width = d3d11_renderer_->width();
    current_height = d3d11_renderer_->height();
  }
  if (pixel_buffer_ != nullptr) {
    current_width = pixel_buffer_textures_.at(texture_id_)->width;
    current_height = pixel_buffer_textures_.at(texture_id_)->height;
  }
  // Currently rendered video output dimensions.
  // Either H/W or S/W rendered.
  assert(current_width > 0);
  assert(current_height > 0);
  if (required_width == current_width && required_height == current_height) {
    // No creation of new texture required.
    return;
  }
  Resize(required_width, required_height);
}

void VideoOutput::Resize(int64_t required_width, int64_t required_height) {
  // Apply the buffer capacity guard even to constructor/caller supplied sizes.
  if (pixel_buffer_ != nullptr) {
    const auto size = FitSoftwareSize(required_width, required_height);
    required_width = size.first;
    required_height = size.second;
  }
  if (required_width < 1 || required_height < 1) return;
  std::cout << required_width << " " << required_height << std::endl;
  // Unregister previously registered texture & delete underlying objects.
  if (texture_id_) {
    UnregisterTexture(texture_id_);
    texture_id_ = 0;
  }
  // H/W
  if (d3d11_renderer_ != nullptr) {
    // Resize the D3D11 texture.
    d3d11_renderer_->SetSize(static_cast<int32_t>(required_width),
                            static_cast<int32_t>(required_height));
    
    auto texture = std::make_unique<FlutterDesktopGpuSurfaceDescriptor>();
    texture->struct_size = sizeof(FlutterDesktopGpuSurfaceDescriptor);
    // Seed with the latest-completed-slot handle so Flutter has a valid
    // surface even before the first mpv frame is committed.
    texture->handle = d3d11_renderer_->ReadHandleSnapshot();
    texture->width = texture->visible_width = d3d11_renderer_->width();
    texture->height = texture->visible_height = d3d11_renderer_->height();
    texture->release_context = nullptr;
    texture->release_callback = [](void*) {};
    texture->format = kFlutterDesktopPixelFormatBGRA8888;

    auto texture_variant =
        std::make_unique<flutter::TextureVariant>(flutter::GpuSurfaceTexture(
            kFlutterDesktopGpuSurfaceTypeDxgiSharedHandle, [&](auto, auto) {
              std::lock_guard<std::mutex> lock(textures_mutex_);
              if (texture_id_) {
                auto* desc = textures_.at(texture_id_).get();
                // ConsumerAcquire() is lock-free.  texture_id_ != 0 implies
                // d3d11_renderer_ is valid: UnregisterTexture guarantees that
                // Flutter stops invoking this callback before the destructor
                // resets d3d11_renderer_.
                desc->handle = d3d11_renderer_->ConsumerAcquire();
                return desc;
              }
              return (FlutterDesktopGpuSurfaceDescriptor*)nullptr;
            }));
    // Register new texture.
    texture_id_ =
        registrar_->texture_registrar()->RegisterTexture(texture_variant.get());
    std::cout << "media_kit: VideoOutput: Create Texture: " << texture_id_
              << std::endl;
    std::lock_guard<std::mutex> lock(textures_mutex_);
    textures_.emplace(std::make_pair(texture_id_, std::move(texture)));
    texture_variants_.emplace(
        std::make_pair(texture_id_, std::move(texture_variant)));
    // Notify public texture update callback.
    texture_update_callback_(texture_id_, required_width, required_height);
  }
  // S/W
  if (pixel_buffer_ != nullptr) {
    auto pixel_buffer_texture = std::make_unique<FlutterDesktopPixelBuffer>();
    pixel_buffer_texture->buffer = pixel_buffer_.get();
    pixel_buffer_texture->width = required_width;
    pixel_buffer_texture->height = required_height;
    pixel_buffer_texture->release_context = nullptr;
    pixel_buffer_texture->release_callback = [](void*) {};
    auto texture_variant = std::make_unique<flutter::TextureVariant>(
        flutter::PixelBufferTexture([&](auto, auto) {
          std::lock_guard<std::mutex> lock(textures_mutex_);
          if (texture_id_) {
            return pixel_buffer_textures_.at(texture_id_).get();
          } else {
            return (FlutterDesktopPixelBuffer*)nullptr;
          }
        }));
    // Register new texture.
    texture_id_ =
        registrar_->texture_registrar()->RegisterTexture(texture_variant.get());
    std::cout << "media_kit: VideoOutput: Create Texture: " << texture_id_
              << std::endl;
    std::lock_guard<std::mutex> lock(textures_mutex_);
    pixel_buffer_textures_.emplace(
        std::make_pair(texture_id_, std::move(pixel_buffer_texture)));
    texture_variants_.emplace(
        std::make_pair(texture_id_, std::move(texture_variant)));
    // Notify public texture update callback.
    texture_update_callback_(texture_id_, required_width, required_height);
  }
}

void VideoOutput::UnregisterTexture(int64_t id) {
  texture_unregistrations_.erase(
      std::remove_if(texture_unregistrations_.begin(),
                     texture_unregistrations_.end(), [](const auto& completion) {
                       return completion.wait_for(std::chrono::seconds(0)) ==
                              std::future_status::ready;
                     }),
      texture_unregistrations_.end());
  auto completion = std::make_shared<std::promise<void>>();
  texture_unregistrations_.push_back(completion->get_future().share());
  registrar_->texture_registrar()->UnregisterTexture(id, [this, id, completion]() {
    {
      std::lock_guard<std::mutex> lock(textures_mutex_);
      if (!destroyed_) {
        texture_variants_.erase(id);
        textures_.erase(id);
        pixel_buffer_textures_.erase(id);
      }
    }
    completion->set_value();
  });
}

std::pair<int64_t, int64_t> VideoOutput::GetVideoSize() {
  int64_t width = 0, height = 0;
  if (!width_ || !height_) {
    mpv_node params{};
    if (mpv_get_property(handle_, "video-out-params", MPV_FORMAT_NODE,
                         &params) < 0) {
      return {0, 0};
    }
    int64_t dw = 0, dh = 0, rotate = 0;
    if (params.format == MPV_FORMAT_NODE_MAP) {
      for (int32_t i = 0; i < params.u.list->num; i++) {
        const auto* key = params.u.list->keys[i];
        const auto value = params.u.list->values[i];
        if (value.format != MPV_FORMAT_INT64) continue;
        if (strcmp(key, "dw") == 0) dw = value.u.int64;
        if (strcmp(key, "dh") == 0) dh = value.u.int64;
        if (strcmp(key, "rotate") == 0) rotate = value.u.int64;
      }
    }
    mpv_free_node_contents(&params);
    const auto rotation = (rotate % 360 + 360) % 360;
    const bool quarter_turn = rotation == 90 || rotation == 270;
    width = quarter_turn ? dh : dw;
    height = quarter_turn ? dw : dh;
  }

  // Explicit dimensions override the corresponding natural dimension, as in
  // the public configuration contract. Fit the resulting pair only once.
  width = width_.value_or(width);
  height = height_.value_or(height);
  if (width <= 0 || height <= 0) return {0, 0};
  if (pixel_buffer_ != nullptr) return FitSoftwareSize(width, height);
  return {width, height};
}
