// air-crsf-encoder.h — Pure CRSF RC_CHANNELS_PACKED (type 0x16) frame builder.
// No hardware deps — separated from UART/task for testability.
//
// Frame layout (26 bytes):
//   [0]    sync   = 0xC8
//   [1]    len    = 0x18 (24: TYPE + 22 payload + CRC)
//   [2]    type   = 0x16 (RC_CHANNELS_PACKED)
//   [3..24] 16 channels × 11 bits LSB-first = 22 bytes
//   [25]   CRC8 DVB-S2 over [2..24]

#pragma once

#include <stdint.h>
#include <stddef.h>

#include "drone-link-protocol.h"

namespace air_crsf {

constexpr size_t   FRAME_SIZE     = 26;
constexpr uint8_t  CRSF_SYNC      = 0xC8;
constexpr uint8_t  CRSF_LEN       = 0x18;  // 24 bytes after this byte
constexpr uint8_t  CRSF_TYPE_RC   = 0x16;
constexpr uint16_t CRSF_CH_MIN    = 172;
constexpr uint16_t CRSF_CH_MID    = 992;
constexpr uint16_t CRSF_CH_MAX    = 1811;

// Build CRSF frame into out[26].
// in == nullptr OR failsafe == true → throttle=172, ARM=172, sticks=992.
void build_frame(const stick_frame_t *in, bool failsafe,
                 uint8_t out[FRAME_SIZE]);

}  // namespace air_crsf
