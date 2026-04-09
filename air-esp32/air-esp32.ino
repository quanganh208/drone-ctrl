// air-esp32.ino — ESP32 #2 "Air module" entry point.
// Receives ESP-NOW stick frames from the GCS and exposes them over Serial
// for Phase 01/02 link validation. No motor output, no CRSF yet.

#include "air-core.h"

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println(F("=============================================="));
  Serial.println(F(" drone-ctrl Air module (ESP32 #2)"));
  Serial.println(F("=============================================="));

  if (!air_core::init()) {
    Serial.println(F("[air] init FAILED — halting"));
    while (true) delay(1000);
  }
  air_core::print_banner();
  air_core::start_tasks();
  Serial.println(F("[air] ready, waiting for GCS frames"));
}

void loop() {
  // Everything happens in the ESP-NOW callback and the serial task.
  vTaskDelay(portMAX_DELAY);
}
