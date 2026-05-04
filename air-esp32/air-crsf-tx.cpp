// air-crsf-tx.cpp — UART2 + 143Hz FreeRTOS task feeding CRSF frames to FC.

#include "air-crsf-tx.h"

#include <Arduino.h>

#include "air-core.h"
#include "air-crsf-encoder.h"

namespace air_crsf_tx {

static constexpr int      FC_TX_PIN            = 17;
static constexpr int      FC_RX_PIN            = 16;
static constexpr uint32_t FC_BAUD              = 420000;
static constexpr uint32_t TX_PERIOD_MS         = 7;       // ~143 Hz
static constexpr uint64_t FAILSAFE_TIMEOUT_US  = 500000ULL;

static HardwareSerial fc_serial(2);
static uint8_t        tx_buf[air_crsf::FRAME_SIZE];

static void crsf_tx_task(void *arg) {
  (void)arg;
  const TickType_t period = pdMS_TO_TICKS(TX_PERIOD_MS);
  TickType_t next = xTaskGetTickCount();

  // Init to true so first transition (FAILSAFE → ACTIVE) prints.
  bool was_failsafe = true;

  for (;;) {
    stick_frame_t snap;
    uint64_t age_us = 0;
    bool has = air_core::snapshot(&snap, &age_us);
    bool fs  = !has || age_us > FAILSAFE_TIMEOUT_US;

    air_crsf::build_frame(has ? &snap : nullptr, fs, tx_buf);
    fc_serial.write(tx_buf, air_crsf::FRAME_SIZE);

    if (fs != was_failsafe) {
      Serial.printf("[air] CRSF %s\n", fs ? "FAILSAFE" : "ACTIVE");
      was_failsafe = fs;
    }

    vTaskDelayUntil(&next, period);
  }
}

void init() {
  fc_serial.begin(FC_BAUD, SERIAL_8N1, FC_RX_PIN, FC_TX_PIN);
  Serial.printf("[air] CRSF TX init: UART2 @%u baud TX=GPIO%d RX=GPIO%d\n",
                (unsigned)FC_BAUD, FC_TX_PIN, FC_RX_PIN);
}

void start_task() {
  xTaskCreatePinnedToCore(crsf_tx_task, "air_crsf",
                          4096, nullptr, 5, nullptr, 1);
}

}  // namespace air_crsf_tx
