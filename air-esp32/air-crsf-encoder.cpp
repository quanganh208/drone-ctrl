// air-crsf-encoder.cpp — pure encoder, no Arduino deps.

#include "air-crsf-encoder.h"

#include <string.h>

namespace air_crsf {

// Linear map [in_min..in_max] → [172..1811] with rounding so that the exact
// mid-point lands on 992 (matches CRSF convention used by Python decoder).
static uint16_t scale_to_crsf(int32_t value, int32_t in_min, int32_t in_max) {
  if (value <= in_min) return CRSF_CH_MIN;
  if (value >= in_max) return CRSF_CH_MAX;
  const int32_t span    = in_max - in_min;
  const int32_t out_rng = (int32_t)(CRSF_CH_MAX - CRSF_CH_MIN);  // 1639
  return (uint16_t)(CRSF_CH_MIN +
                    ((value - in_min) * out_rng + span / 2) / span);
}

// 16 channels × 11 bits, LSB-first. Inverse of STM32 unpack at
// stm32f4xx_it.c:152-167 — verified bit-by-bit.
static void pack_channels(const uint16_t ch[16], uint8_t out[22]) {
  memset(out, 0, 22);
  uint32_t bit_pos = 0;
  for (int i = 0; i < 16; i++) {
    const uint32_t byte_idx = bit_pos / 8;
    const uint32_t bit_off  = bit_pos % 8;
    const uint32_t value    = ch[i] & 0x07FF;  // 11 bits

    out[byte_idx]     |= (uint8_t)(value << bit_off);
    out[byte_idx + 1] |= (uint8_t)(value >> (8 - bit_off));
    if (bit_off > 5) {
      // 11 bits spill into a 3rd byte.
      out[byte_idx + 2] |= (uint8_t)(value >> (16 - bit_off));
    }
    bit_pos += 11;
  }
}

// CRC8 DVB-S2, poly 0xD5. Mirror of STM32 crsf_crc8() at stm32f4xx_it.c:74.
static uint8_t crc8_dvb_s2(uint8_t crc, uint8_t data) {
  crc ^= data;
  for (int i = 0; i < 8; i++) {
    crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0xD5) : (uint8_t)(crc << 1);
  }
  return crc;
}

static uint8_t crsf_crc(const uint8_t *data, size_t len) {
  uint8_t crc = 0;
  for (size_t i = 0; i < len; i++) crc = crc8_dvb_s2(crc, data[i]);
  return crc;
}

void build_frame(const stick_frame_t *in, bool failsafe,
                 uint8_t out[FRAME_SIZE]) {
  const bool fs = failsafe || (in == nullptr);

  uint16_t ch[16];
  if (fs) {
    ch[0] = ch[1] = ch[3] = CRSF_CH_MID;  // roll/pitch/yaw center
    ch[2] = CRSF_CH_MIN;                  // throttle = 172
    ch[4] = CRSF_CH_MIN;                  // ARM = low
  } else {
    ch[0] = scale_to_crsf(in->roll,     -1000, 1000);
    ch[1] = scale_to_crsf(in->pitch,    -1000, 1000);
    ch[2] = scale_to_crsf(in->throttle,     0, 2000);
    ch[3] = scale_to_crsf(in->yaw,      -1000, 1000);
    ch[4] = (in->flags & DRONE_LINK_FLAG_ARM_REQ) ? CRSF_CH_MAX : CRSF_CH_MIN;
  }
  for (int i = 5; i < 16; i++) ch[i] = CRSF_CH_MID;

  out[0] = CRSF_SYNC;
  out[1] = CRSF_LEN;
  out[2] = CRSF_TYPE_RC;
  pack_channels(ch, out + 3);
  // CRC over TYPE + payload = 23 bytes starting at out[2].
  out[25] = crsf_crc(out + 2, 23);
}

}  // namespace air_crsf
