// air-crsf-tx.h — Serial2 (UART2) @420000 baud + FreeRTOS task that
// emits CRSF RC_CHANNELS_PACKED frames at ~143Hz to the FC.

#pragma once

namespace air_crsf_tx {

// Init UART2 on GPIO16 (RX, reserved for telemetry) / GPIO17 (TX). Call
// from setup() after air_core::init().
void init();

// Spawn the 143Hz CRSF TX task pinned to APP_CPU (core 1), priority 5.
// Call after init() and after air_core::start_tasks().
void start_task();

}  // namespace air_crsf_tx
