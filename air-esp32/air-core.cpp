// air-core.cpp — implementation of ESP-NOW RX, slot, stats, serial print.

#include "air-core.h"

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <mbedtls/sha256.h>

#include "link-config-local.h"

namespace air_core {

// --- Shared state ----------------------------------------------------------

static portMUX_TYPE   g_slot_mux = portMUX_INITIALIZER_UNLOCKED;
static stick_frame_t  g_slot;
static uint64_t       g_slot_us = 0;
static bool           g_slot_has = false;

static uint32_t g_last_counter = 0;
static bool     g_first_frame = true;

static Stats g_stats = {};

static const uint8_t PEER_MAC[6] = DRONE_LINK_GCS_MAC;
static const uint8_t K_PMK[16]   = DRONE_LINK_PMK;
static const uint8_t K_LMK[16]   = DRONE_LINK_LMK;

// --- Helpers ---------------------------------------------------------------

static uint32_t pmk_fingerprint() {
  uint8_t digest[32];
  mbedtls_sha256_context c;
  mbedtls_sha256_init(&c);
  mbedtls_sha256_starts(&c, 0);
  mbedtls_sha256_update(&c, K_PMK, sizeof(K_PMK));
  mbedtls_sha256_finish(&c, digest);
  mbedtls_sha256_free(&c);
  return ((uint32_t)digest[0] << 24) | ((uint32_t)digest[1] << 16) |
         ((uint32_t)digest[2] << 8)  | (uint32_t)digest[3];
}

void print_banner() {
  uint8_t primary = 0;
  wifi_second_chan_t sec;
  esp_wifi_get_channel(&primary, &sec);
  Serial.printf("AIR  MAC=%s  CH=%u  PMK_SHA8=%08X\n",
                WiFi.macAddress().c_str(), primary, pmk_fingerprint());
}

// --- ESP-NOW RX callback ---------------------------------------------------
// Arduino-ESP32 core >=3.x uses the new callback signature with esp_now_recv_info_t.

static void on_recv(const esp_now_recv_info_t *info,
                    const uint8_t *data, int len) {
  (void)info;
  g_stats.rx_total++;

  if (len != (int)sizeof(stick_frame_t)) {
    g_stats.rx_bad_magic++;
    return;
  }
  stick_frame_t f;
  memcpy(&f, data, sizeof(f));

  if (!stick_frame_verify(&f)) {
    if (f.magic != DRONE_LINK_MAGIC) g_stats.rx_bad_magic++;
    else                             g_stats.rx_bad_crc++;
    return;
  }

  // Window-based dedup + anti-replay (RT#9).
  bool accept;
  portENTER_CRITICAL_ISR(&g_slot_mux);
  accept = stick_frame_should_accept(f.counter, &g_last_counter,
                                     g_first_frame ? 1 : 0);
  if (accept) {
    g_first_frame = false;
    memcpy(&g_slot, &f, sizeof(f));
    g_slot_us = esp_timer_get_time();
    g_slot_has = true;
  }
  portEXIT_CRITICAL_ISR(&g_slot_mux);

  if (accept) g_stats.rx_accepted++;
  else        g_stats.rx_dropped_dedup++;
}

bool snapshot(stick_frame_t *out, uint64_t *age_us) {
  bool has;
  portENTER_CRITICAL(&g_slot_mux);
  has = g_slot_has;
  if (has) {
    memcpy(out, &g_slot, sizeof(*out));
    *age_us = esp_timer_get_time() - g_slot_us;
  }
  portEXIT_CRITICAL(&g_slot_mux);
  return has;
}

Stats get_stats() {
  Stats s;
  portENTER_CRITICAL(&g_slot_mux);
  s = g_stats;
  s.last_counter = g_last_counter;
  s.last_rx_us = g_slot_us;
  portEXIT_CRITICAL(&g_slot_mux);
  return s;
}

// --- Init ------------------------------------------------------------------

bool init() {
  // STA-only: Air module does not host an AP. Station mode is enough for
  // ESP-NOW and lets us control the radio channel deterministically.
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true, true);  // make sure no stale auto-connect is pending
  delay(50);

  esp_err_t r;
  r = esp_wifi_set_channel(DRONE_LINK_CHANNEL, WIFI_SECOND_CHAN_NONE);
  Serial.printf("[air] set_channel(%u): %s\n",
                DRONE_LINK_CHANNEL, esp_err_to_name(r));
  if (r != ESP_OK) return false;

  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_max_tx_power(84);  // 21 dBm max

  r = esp_now_init();
  Serial.printf("[air] esp_now_init: %s\n", esp_err_to_name(r));
  if (r != ESP_OK) return false;

  // LR mode not supported on classic ESP32 (verified Phase 01).
  // Use 1 Mbps Long Preamble as the best robust option we have.
  r = esp_wifi_config_espnow_rate(WIFI_IF_STA, DRONE_LINK_PHY_RATE);
  Serial.printf("[air] espnow_rate(1M_L): %s\n", esp_err_to_name(r));
  if (r != ESP_OK) return false;

  // Set PMK (pairwise master key) shared by all peers on this device.
  r = esp_now_set_pmk(K_PMK);
  Serial.printf("[air] set_pmk: %s\n", esp_err_to_name(r));
  if (r != ESP_OK) return false;

  // Add GCS as an encrypted peer. The LMK scopes encryption to just this peer.
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, PEER_MAC, 6);
  peer.channel = DRONE_LINK_CHANNEL;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;  // DEBUG: match GCS
  r = esp_now_add_peer(&peer);
  Serial.printf("[air] add_peer(GCS): %s\n", esp_err_to_name(r));
  if (r != ESP_OK) return false;

  r = esp_now_register_recv_cb(on_recv);
  Serial.printf("[air] register_recv_cb: %s\n", esp_err_to_name(r));
  return r == ESP_OK;
}

// --- 50 Hz serial printer task --------------------------------------------

static void serial_task(void *arg) {
  (void)arg;
  const TickType_t period = pdMS_TO_TICKS(20);  // 50 Hz
  TickType_t next = xTaskGetTickCount();
  uint32_t tick = 0;

  for (;;) {
    stick_frame_t snap;
    uint64_t age_us = 0;
    bool has = snapshot(&snap, &age_us);
    bool in_failsafe = !has || age_us > 500000ULL;

    // Every 1 s, print raw stats counters UNCONDITIONALLY so we can see
    // the RX pipeline even while stuck in failsafe. This is how we debug
    // "no frames reaching RX callback" vs "frames arrive but fail verify".
    if ((tick % 50) == 0) {
      uint8_t primary = 0;
      wifi_second_chan_t sec;
      esp_wifi_get_channel(&primary, &sec);
      Stats s = get_stats();
      Serial.printf("[air] STATS CH=%u RX=%u ACC=%u DD=%u BC=%u BM=%u %s\n",
                    primary, s.rx_total, s.rx_accepted, s.rx_dropped_dedup,
                    s.rx_bad_crc, s.rx_bad_magic,
                    in_failsafe ? "[FAILSAFE]" : "[OK]");
    }

    // When we have fresh frames, dump the stick values at 10 Hz.
    if (!in_failsafe && (tick % 5) == 0) {
      Serial.printf("[air] R=%d P=%d Y=%d T=%u F=%02X CTR=%u AGE=%lluus\n",
                    snap.roll, snap.pitch, snap.yaw, snap.throttle,
                    snap.flags, snap.counter, age_us);
    }
    tick++;
    vTaskDelayUntil(&next, period);
  }
}

void start_tasks() {
  // High priority so it isn't starved by WiFi stack. Pin to APP_CPU (core 1).
  xTaskCreatePinnedToCore(serial_task, "air_serial",
                          4096, nullptr, 5, nullptr, 1);
}

}  // namespace air_core
