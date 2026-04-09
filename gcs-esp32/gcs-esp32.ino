// gcs-esp32.ino — Ground station ESP32 #1 entry point.
// Hosts a WiFi SoftAP, receives stick frames from the host over UDP, and
// relays them to the Air module over ESP-NOW. No FC connection yet.

#include "gcs-core.h"

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println(F("=============================================="));
  Serial.println(F(" drone-ctrl Ground Station (ESP32 #1)"));
  Serial.println(F("=============================================="));

  if (!gcs_core::init()) {
    Serial.println(F("[gcs] init FAILED — halting"));
    while (true) delay(1000);
  }
  gcs_core::print_banner();
  gcs_core::start_tasks();
  Serial.println(F("[gcs] ready"));
}

void loop() {
  vTaskDelay(portMAX_DELAY);
}
