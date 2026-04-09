// air-core.h — ESP-NOW RX + slot state + stats + serial printer for
// ESP32 #2 ("Air module"). Consolidated per red-team RT#13 (2 files only).

#pragma once

#include <Arduino.h>
#include "drone-link-protocol.h"

namespace air_core {

// Initialise WiFi, channel lock, ESP-NOW with encrypted peer, power save off.
// Returns true on success. Must be called once from setup().
bool init();

// Start background tasks: dedupe is inside ESP-NOW callback, but the
// 50 Hz serial printer runs in its own FreeRTOS task pinned to APP_CPU.
void start_tasks();

// Counters are accessed from the serial printer; cheap reads, no lock.
struct Stats {
  uint32_t rx_total;
  uint32_t rx_bad_crc;
  uint32_t rx_bad_magic;
  uint32_t rx_dropped_dedup;
  uint32_t rx_accepted;
  uint32_t last_counter;
  uint64_t last_rx_us;
};

// Snapshot the latest valid stick frame plus age (µs). Thread-safe via
// critical section. Returns true if a frame has ever been received.
bool snapshot(stick_frame_t *out, uint64_t *age_us);

// Read current stats (non-atomic but sufficient for debug print).
Stats get_stats();

// Banner string (MAC, channel, SHA8 of PMK) for boot-time print.
void print_banner();

}  // namespace air_core
