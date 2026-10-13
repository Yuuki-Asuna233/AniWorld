#ifndef MEDIA_KIT_FRAME_COMPLETION_NOTIFIER_H_
#define MEDIA_KIT_FRAME_COMPLETION_NOTIFIER_H_

#include <d3d11_4.h>
#include <wrl.h>
#include <chrono>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>

// Wait off both the render and Flutter threads. Immutable COM snapshots keep
// old resize fences alive; only the latest submission needs a notification.
class FrameCompletionNotifier {
 public:
  explicit FrameCompletionNotifier(std::function<void()> notify)
      : notify_(std::move(notify)), worker_([this] { Run(); }) {}
  ~FrameCompletionNotifier() { Stop(); }

  void Submit(Microsoft::WRL::ComPtr<ID3D11Fence> fence, uint64_t value) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_) return;
    fence_ = std::move(fence);
    value_ = value;
    ++revision_;
    changed_.notify_one();
  }

  void Stop() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      stopped_ = true;
    }
    changed_.notify_one();
    if (worker_.joinable()) worker_.join();
  }

 private:
  void Run() {
    uint64_t observed = 0;
    std::unique_lock<std::mutex> lock(mutex_);
    while (!stopped_) {
      changed_.wait(lock, [&] { return stopped_ || revision_ != observed; });
      if (stopped_) break;
      observed = revision_;
      const auto fence = fence_;
      const auto value = value_;
      const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
      while (!stopped_ && revision_ == observed) {
        lock.unlock();
        const bool complete = fence && fence->GetCompletedValue() >= value;
        if (complete) {
          try { notify_(); } catch (...) { /* Shutdown must not terminate the process. */ }
        }
        lock.lock();
        if (complete || std::chrono::steady_clock::now() >= deadline) break;
        changed_.wait_for(lock, std::chrono::milliseconds(2),
                          [&] { return stopped_ || revision_ != observed; });
      }
    }
  }

  std::function<void()> notify_;
  std::mutex mutex_;
  std::condition_variable changed_;
  Microsoft::WRL::ComPtr<ID3D11Fence> fence_;
  uint64_t value_ = 0, revision_ = 0;
  bool stopped_ = false;
  std::thread worker_;
};
#endif
