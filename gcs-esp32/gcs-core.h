// gcs-core.h — Ground Station (ESP32 #1) core: SoftAP + UDP server +
// latest-wins slot + ESP-NOW TX tick + stats. Single translation unit per
// red-team RT#13.

#pragma once

#include <Arduino.h>
#include "drone-link-protocol.h"

namespace gcs_core {

// Bring up WiFi in AP+STA mode, start SoftAP, lock channel, init ESP-NOW
// with encrypted peer = Air. Returns true on success.
bool init();

// Start UDP server, 100 Hz TX tick task, 1 Hz stats printer.
void start_tasks();

// Banner: MAC(STA/AP), channel, PMK fingerprint.
void print_banner();

struct Stats {
  uint32_t rx_udp_total;     // UDP packets received on 8888
  uint32_t rx_udp_bad;       // failed size/magic/CRC
  uint32_t rx_udp_accepted;  // passed into slot
  uint32_t tx_espnow_total;  // ESP-NOW sends attempted (counts redundancy)
  uint32_t tx_espnow_ok;     // send-cb OK
  uint32_t tx_espnow_fail;   // send-cb FAIL
  uint64_t slot_age_us;      // age of slot at last tick
};

Stats get_stats();

}  // namespace gcs_core
