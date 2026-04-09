// smoke-preflight.ino — Phase 01 smoke test + preflight probes
// Purpose: verify board boots, LED blinks, ESP-NOW LR rate is supported,
// WiFi SoftAP+channel-lock works. Print results over Serial for triage.
// RT#1 (LR preflight) + RT#5 (blink/banner) + RT#6 (channel verify)
//
// Flash to BOTH ESP32 for initial identification — each prints its MAC,
// allowing flash-by-mac helper scripts to map physical port ↔ logical role.

#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_now.h>

// LED pin — GPIO2 is typical on NodeMCU DevKit V1 and WROOM-32 DevKitC.
// If your board's LED is elsewhere (or absent), the serial banner is the
// authoritative aliveness signal. LED is best-effort only (RT#15).
static const int LED_PIN = 2;

// Target channel for ESP-NOW + SoftAP coexistence test.
static const uint8_t TARGET_CHANNEL = 6;

// --- Helpers ---------------------------------------------------------------

static void print_banner() {
  Serial.println();
  Serial.println(F("=============================================="));
  Serial.println(F(" smoke-preflight | drone-ctrl Phase 01"));
  Serial.println(F("=============================================="));
  Serial.printf("MAC(STA): %s\n", WiFi.macAddress().c_str());
  Serial.printf("SDK:      %s\n", ESP.getSdkVersion());
  Serial.printf("Chip:     %s rev %d, %d cores, %d MHz\n",
                ESP.getChipModel(), ESP.getChipRevision(),
                ESP.getChipCores(), ESP.getCpuFreqMHz());
  Serial.printf("Flash:    %u bytes\n", ESP.getFlashChipSize());
}

// Test RT#1: LR mode availability + channel lock + SoftAP coexistence.
static void run_preflight() {
  Serial.println(F("\n--- Preflight RT#1 ---"));

  // 1. Start WiFi in AP+STA so both ESP-NOW (STA interface) and SoftAP work.
  WiFi.mode(WIFI_AP_STA);
  delay(100);
  Serial.printf("MAC(AP):  %s\n", WiFi.softAPmacAddress().c_str());

  // 2. Lock channel BEFORE starting SoftAP. Some Arduino-ESP32 bugs make
  //    softAP channel arg inconsistent; use esp_wifi_set_channel as truth.
  esp_err_t r;
  r = esp_wifi_set_channel(TARGET_CHANNEL, WIFI_SECOND_CHAN_NONE);
  Serial.printf("set_channel(%u): %s\n", TARGET_CHANNEL, esp_err_to_name(r));

  // 3. Bring up SoftAP on same channel (coexistence scenario).
  bool ok = WiFi.softAP("PREFLIGHT", "12345678", TARGET_CHANNEL, 0, 1);
  Serial.printf("softAP: %s\n", ok ? "OK" : "FAIL");

  // 4. Verify channel actually matches the target after AP start.
  uint8_t primary = 0;
  wifi_second_chan_t second;
  esp_wifi_get_channel(&primary, &second);
  Serial.printf("get_channel: primary=%u %s\n",
                primary,
                primary == TARGET_CHANNEL ? "(OK)" : "(MISMATCH)");

  // 5. Disable power save — required for low-latency ESP-NOW.
  r = esp_wifi_set_ps(WIFI_PS_NONE);
  Serial.printf("set_ps(NONE): %s\n", esp_err_to_name(r));

  // 6. Max TX power (21 dBm) for best range.
  r = esp_wifi_set_max_tx_power(84);
  Serial.printf("set_tx_pow(84): %s\n", esp_err_to_name(r));

  // 7. Initialize ESP-NOW so we can probe the PHY rate API.
  r = esp_now_init();
  Serial.printf("esp_now_init: %s\n", esp_err_to_name(r));

  // 8. Try to configure ESP-NOW to LR (Long Range) 250 kbps rate.
  //    If this returns ESP_ERR_NOT_SUPPORTED the board firmware does not
  //    expose LR mode and we must fall back to standard rates.
  r = esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_LORA_250K);
  Serial.printf("espnow_rate(LORA_250K): %s\n", esp_err_to_name(r));
  if (r != ESP_OK) {
    // Fallback probe: 1 Mbps long preamble — always available.
    r = esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_1M_L);
    Serial.printf("espnow_rate(1M_L fallback): %s\n", esp_err_to_name(r));
  }

  Serial.println(F("--- Preflight done ---\n"));
}

// --- Arduino entry points --------------------------------------------------

void setup() {
  pinMode(LED_PIN, OUTPUT);
  Serial.begin(115200);
  delay(200);                 // let USB CDC settle
  print_banner();
  run_preflight();
  Serial.println(F("Entering heartbeat loop. LED blinks 1 Hz."));
}

void loop() {
  static uint32_t tick = 0;
  digitalWrite(LED_PIN, tick & 1);
  Serial.printf("heartbeat %u MAC=%s ch=%u\n",
                tick, WiFi.macAddress().c_str(),
                [](){ uint8_t p=0; wifi_second_chan_t s; esp_wifi_get_channel(&p,&s); return p; }());
  tick++;
  delay(500);
}
