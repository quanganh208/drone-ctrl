// air-esp32.ino — ESP32 #2 "Air module" entry point.
// ESP-NOW RX → decode + dedup → CRSF 0x16 over UART2 (420000 baud) to STM32 FC.

#include "air-core.h"
#include "air-crsf-tx.h"

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
  air_crsf_tx::init();
  air_crsf_tx::start_task();
  Serial.println(F("[air] ready, waiting for GCS frames"));
}

void loop() {
  // Everything happens in the ESP-NOW callback and the serial task.
  vTaskDelay(portMAX_DELAY);
}
