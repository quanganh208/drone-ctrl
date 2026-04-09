// gcs-core.cpp — ESP32 #1 GCS core implementation (v2: USB serial transport).
//
// Architecture pivot (2026-04-09): SoftAP + UDP dropped due to ESP-NOW +
// SoftAP coexistence instability on Arduino-ESP32 core 3.3.7 (verified
// in the field: 59% TX success rate, Air boot-loops, ping RTT 2→1046ms).
// Host now talks to GCS over USB CDC serial (binary frames in, ASCII
// logs out). Radio is 100% dedicated to ESP-NOW — no AP contention.
//
// Wire format host→GCS over USB:
//   Stream of back-to-back 18-byte stick_frame_t (no framing bytes).
//   Reader scans for magic 0xC3 0xA5 (little-endian 0xA5C3) to sync.
//   Frames are length-fixed so only magic sync + CRC validation needed.
//
// GCS→host output stays human-readable ASCII on stdout for monitoring.

#include "gcs-core.h"

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <mbedtls/sha256.h>

#include "link-config-local.h"

namespace gcs_core {

// --- Config / state --------------------------------------------------------

static const uint8_t PEER_MAC[6] = DRONE_LINK_AIR_MAC;

static portMUX_TYPE  g_slot_mux = portMUX_INITIALIZER_UNLOCKED;
static stick_frame_t g_slot;
static uint64_t      g_slot_us = 0;
static bool          g_slot_has = false;

static Stats g_stats = {};

// --- Utility ---------------------------------------------------------------

// Fingerprint disabled — no PMK in unencrypted build. Kept as a stub so
// the banner format stays stable.
static uint32_t pmk_fingerprint() { return 0; }

void print_banner() {
  uint8_t primary = 0;
  wifi_second_chan_t sec;
  esp_wifi_get_channel(&primary, &sec);
  Serial.printf("GCS  STA=%s  CH=%u  TRANSPORT=USB-CDC\n",
                WiFi.macAddress().c_str(), primary);
  Serial.printf("[gcs] host feeds 18-byte stick_frame_t via stdin\n");
}

// --- ESP-NOW send callback -------------------------------------------------

static void on_espnow_send(const wifi_tx_info_t *info,
                           esp_now_send_status_t st) {
  (void)info;
  if (st == ESP_NOW_SEND_SUCCESS) g_stats.tx_espnow_ok++;
  else                             g_stats.tx_espnow_fail++;
}

// --- USB serial frame reader task -----------------------------------------
//
// Scans the incoming byte stream for the 2-byte magic (0xC3, 0xA5 in
// little-endian order), then reads the remaining 16 bytes and validates
// CRC. Any bytes that look like text (stray log echoes, etc.) are skipped
// by the sync search and ignored.

static void host_serial_task(void *arg) {
  (void)arg;
  enum { WAIT_M1, WAIT_M2, READ_BODY } state = WAIT_M1;
  uint8_t buf[sizeof(stick_frame_t)];
  size_t  have = 0;

  for (;;) {
    while (Serial.available() > 0) {
      int c = Serial.read();
      if (c < 0) break;
      uint8_t b = (uint8_t)c;

      switch (state) {
        case WAIT_M1:
          if (b == 0xC3) { buf[0] = 0xC3; state = WAIT_M2; }
          break;
        case WAIT_M2:
          if (b == 0xA5) { buf[1] = 0xA5; have = 2; state = READ_BODY; }
          else if (b == 0xC3) { /* stay */ }
          else { state = WAIT_M1; }
          break;
        case READ_BODY:
          buf[have++] = b;
          if (have == sizeof(stick_frame_t)) {
            g_stats.rx_udp_total++;
            stick_frame_t f;
            memcpy(&f, buf, sizeof(f));
            if (stick_frame_verify(&f)) {
              portENTER_CRITICAL(&g_slot_mux);
              memcpy(&g_slot, &f, sizeof(f));
              g_slot_us = esp_timer_get_time();
              g_slot_has = true;
              portEXIT_CRITICAL(&g_slot_mux);
              g_stats.rx_udp_accepted++;
            } else {
              g_stats.rx_udp_bad++;
            }
            state = WAIT_M1;
            have = 0;
          }
          break;
      }
    }
    // Yield briefly so we don't hog the core; USB CDC is interrupt-driven
    // so this only adds a few hundred µs of worst-case latency.
    vTaskDelay(pdMS_TO_TICKS(1));
  }
}

// --- 100 Hz TX tick task ---------------------------------------------------

static void tx_tick_task(void *arg) {
  (void)arg;
  const TickType_t period = pdMS_TO_TICKS(10);  // 100 Hz
  TickType_t next = xTaskGetTickCount();
  uint32_t fs_counter = 0;

  for (;;) {
    stick_frame_t snap;
    uint64_t age_us = 0;
    bool has;

    portENTER_CRITICAL(&g_slot_mux);
    has = g_slot_has;
    if (has) {
      memcpy(&snap, &g_slot, sizeof(snap));
      age_us = esp_timer_get_time() - g_slot_us;
    }
    portEXIT_CRITICAL(&g_slot_mux);
    g_stats.slot_age_us = age_us;

    if (!has || age_us > 200000ULL) {
      stick_frame_make_failsafe(&snap, ++fs_counter);
    } else {
      stick_frame_fill_crc(&snap);
    }

    // Redundancy ×2 for robustness.
    for (int i = 0; i < 2; i++) {
      esp_now_send(PEER_MAC, (const uint8_t *)&snap, sizeof(snap));
      g_stats.tx_espnow_total++;
    }

    vTaskDelayUntil(&next, period);
  }
}

// --- 1 Hz stats printer ----------------------------------------------------

static void stats_task(void *arg) {
  (void)arg;
  for (;;) {
    Stats s = get_stats();
    uint8_t primary = 0;
    wifi_second_chan_t sec;
    esp_wifi_get_channel(&primary, &sec);
    Serial.printf("[gcs] CH=%u RX=%u OK=%u BAD=%u | "
                  "TX=%u OK=%u FAIL=%u | AGE_us=%llu\n",
                  primary,
                  s.rx_udp_total, s.rx_udp_accepted, s.rx_udp_bad,
                  s.tx_espnow_total, s.tx_espnow_ok, s.tx_espnow_fail,
                  s.slot_age_us);
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

Stats get_stats() {
  Stats s;
  portENTER_CRITICAL(&g_slot_mux);
  s = g_stats;
  portEXIT_CRITICAL(&g_slot_mux);
  return s;
}

// --- Init ------------------------------------------------------------------

bool init() {
  // STA-only — no SoftAP. Full radio goes to ESP-NOW.
  WiFi.mode(WIFI_STA);
  delay(50);

  esp_err_t r;
  r = esp_wifi_set_channel(DRONE_LINK_CHANNEL, WIFI_SECOND_CHAN_NONE);
  Serial.printf("[gcs] set_channel(%u): %s\n",
                DRONE_LINK_CHANNEL, esp_err_to_name(r));
  if (r != ESP_OK) return false;

  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_max_tx_power(84);

  r = esp_now_init();
  Serial.printf("[gcs] esp_now_init: %s\n", esp_err_to_name(r));
  if (r != ESP_OK) return false;

  r = esp_wifi_config_espnow_rate(WIFI_IF_STA, DRONE_LINK_PHY_RATE);
  Serial.printf("[gcs] espnow_rate(1M_L): %s\n", esp_err_to_name(r));
  if (r != ESP_OK) return false;

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, PEER_MAC, 6);
  peer.channel = DRONE_LINK_CHANNEL;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  r = esp_now_add_peer(&peer);
  Serial.printf("[gcs] add_peer(AIR): %s\n", esp_err_to_name(r));
  if (r != ESP_OK) return false;

  r = esp_now_register_send_cb(on_espnow_send);
  Serial.printf("[gcs] register_send_cb: %s\n", esp_err_to_name(r));
  return r == ESP_OK;
}

void start_tasks() {
  // host_serial_task: lowest priority, core 1. It's IO-bound.
  xTaskCreatePinnedToCore(host_serial_task, "gcs_host",
                          4096, nullptr, 4, nullptr, 1);
  // tx_tick_task: highest so it doesn't slip under CPU load.
  xTaskCreatePinnedToCore(tx_tick_task, "gcs_tx",
                          4096, nullptr, 6, nullptr, 1);
  // stats_task: lowest, runs 1 Hz.
  xTaskCreatePinnedToCore(stats_task, "gcs_stat",
                          3072, nullptr, 2, nullptr, 1);
}

}  // namespace gcs_core
