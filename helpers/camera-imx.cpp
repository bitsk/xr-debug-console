// SPDX-License-Identifier: GPL-3.0-or-later
// Bounded IMX471 observer for an ALREADY CONFIGURED pair. The device executor
// verifies slot4=PHY1 and slot5=PHY0 before invoking it. Never changes the graph,
// exposure, GPIOs or the tracking service. Shares the capture ownership lock.
#include <xr/device/passthrough-capture.hpp>
using Camera = a081::device::passthrough::Capture;
#include <cerrno>
#include <atomic>
#include <csignal>
#include <cstdio>
#include <fstream>
#include <future>
#include <linux/videodev2.h>
#include <poll.h>
#include <stdexcept>
#include <string>
#include <sys/file.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <vector>

static volatile sig_atomic_t stopped;
static void stop(int) { stopped = 1; }
static void check(int rc, const char *operation) {
    if (rc < 0) throw std::runtime_error(std::string(operation)+": "+std::strerror(errno));
}

static std::uint64_t now() {
    timespec ts{}; check(clock_gettime(CLOCK_MONOTONIC, &ts), "clock");
    return std::uint64_t(ts.tv_sec)*1000000000+ts.tv_nsec;
}

int main(int argc, char **argv) {
    if (argc != 4) { std::fprintf(stderr, "Usage: camera-imx SLOT4_VIDEO SLOT5_VIDEO SECONDS(1..300)\n"); return 2; }
    int lock = -1, result = 0;
    try {
        std::ifstream file("/proc/device-tree/model", std::ios::binary);
        const std::string model((std::istreambuf_iterator<char>(file)), {});
        if (getuid() || model.find("A081") == std::string::npos || !std::getenv("A081_CAMERA_PREVIEW_SOCKET"))
            throw std::runtime_error("Requires root on A081 and explicit preview socket");
        char *end = nullptr; long seconds = std::strtol(argv[3], &end, 10);
        if (!*argv[3] || *end || seconds < 1 || seconds > 300 || std::strcmp(argv[1], argv[2]) == 0)
            throw std::runtime_error("Distinct slot nodes and bounded duration required");
        lock = ::open("/run/a081-camera.lock", O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0600);
        check(lock, "camera lock"); check(flock(lock, LOCK_EX | LOCK_NB), "Camera owned by tracking; stop via owner first");
        std::signal(SIGINT, stop); std::signal(SIGTERM, stop);
        Camera right, left; right.open(argv[1]); left.open(argv[2]);
        const auto deadline = now()+std::uint64_t(seconds)*1000000000;
        std::atomic<bool> failed{false};
        auto capture = [&](Camera &camera, unsigned slot) {
            try {
                camera.start();
                // Drain immediately; the other sensor's STREAMON may take
                // longer than the first sensor's entire buffer queue.
                while (!stopped && !failed.load() && now() < deadline) {
                    pollfd fd{camera.fd(), POLLIN, 0};
                    int rc = poll(&fd, 1, 100);
                    if (rc < 0 && errno == EINTR) continue;
                    check(rc, "poll");
                    if (fd.revents & (POLLERR | POLLHUP | POLLNVAL)) throw std::runtime_error("Camera poll error");
                    if (fd.revents & POLLIN) camera.frame(slot);
                }
            } catch (...) { failed.store(true); throw; }
        };
        auto first = std::async(std::launch::async, capture, std::ref(right), 4);
        try {
            auto second = std::async(std::launch::async, capture, std::ref(left), 5);
            first.get(); second.get();
        } catch (...) { failed.store(true); throw; }
        std::fprintf(stdout, "IMX slot4_frames=%llu slot4_invalid=%llu slot5_frames=%llu slot5_invalid=%llu\n",
            static_cast<unsigned long long>(right.frames), static_cast<unsigned long long>(right.invalid),
            static_cast<unsigned long long>(left.frames), static_cast<unsigned long long>(left.invalid));
        if (!right.frames || !left.frames) throw std::runtime_error("No complete IMX frames");
    } catch (const std::exception &e) { std::fprintf(stderr, "%s\n", e.what()); result = 1; }
    if (lock >= 0) close(lock);
    return result;
}
