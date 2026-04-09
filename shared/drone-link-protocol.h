// drone-link-protocol.h — wire protocol shared by host, GCS, Air firmware.
// Single source of truth for stick_frame_t struct + CRC16 + helpers.
//
// Version: 0.2 (post red-team, 2026-04-08)
// - uint32 monotonic counter (anti-replay, RT#4)
// - ARM_REQ bit in flags (RT#12)
// - static_assert C++11 compatible (RT#11)
// - Window-based dedup helper (RT#9)
//
// Wire format (18 bytes, little-endian, packed):
//   [0..1]   magic   = 0xA5C3
//   [2]      type    = 0x01 STICK | 0x20 TELEM | 0x7F ACK
//   [3]      flags   bit0=ARM_REQ bit1-2=mode bit3=FS_SET
//   [4..7]   counter uint32 monotonic (never wraps at 100Hz for 1.3 years)
//   [8..9]   roll    int16  [-1000..+1000]
//   [10..11] pitch   int16  [-1000..+1000]
//   [12..13] yaw     int16  [-1000..+1000]
//   [14..15] throttle uint16 [0..2000]
//   [16..17] crc16   CRC-16/CCITT over bytes[0..15]
//
// Safety convention (RT#12):
//   Receiver MUST see flags.ARM_REQ=1 for >=20 consecutive accepted frames
//   (200ms @100Hz) before transitioning to ARMED state. Any single frame
//   with ARM_REQ=0 resets the counter.

#pragma once

#include <stdint.h>
#include <stddef.h>
#include <string.h>

#ifdef __cplusplus
extern "C" {
#endif

// --- Constants -------------------------------------------------------------

#define DRONE_LINK_MAGIC        ((uint16_t)0xA5C3)

#define DRONE_LINK_TYPE_STICK   ((uint8_t)0x01)
#define DRONE_LINK_TYPE_TELEM   ((uint8_t)0x20)
#define DRONE_LINK_TYPE_ACK     ((uint8_t)0x7F)

#define DRONE_LINK_FLAG_ARM_REQ ((uint8_t)(1 << 0))
#define DRONE_LINK_FLAG_MODE_MASK ((uint8_t)(3 << 1))  // bits 1-2
#define DRONE_LINK_FLAG_MODE_SHIFT 1
#define DRONE_LINK_FLAG_FS_SET  ((uint8_t)(1 << 3))

// Stick axis range.
#define DRONE_LINK_STICK_MIN    (-1000)
#define DRONE_LINK_STICK_MAX    (1000)
#define DRONE_LINK_THROTTLE_MAX (2000)

// Arming hold requirement (RT#12).
#define DRONE_LINK_ARM_HOLD_FRAMES 20

// Reorder window for dedup (RT#9).
// Accept any counter within [last - REORDER_BACK, last + REORDER_FWD].
#define DRONE_LINK_REORDER_BACK 3
#define DRONE_LINK_REORDER_FWD  128

// --- Wire struct -----------------------------------------------------------

typedef struct __attribute__((packed)) {
  uint16_t magic;     // DRONE_LINK_MAGIC
  uint8_t  type;      // DRONE_LINK_TYPE_*
  uint8_t  flags;     // ARM_REQ | MODE | FS
  uint32_t counter;   // monotonic, never wraps
  int16_t  roll;      // [-1000..+1000]
  int16_t  pitch;     // [-1000..+1000]
  int16_t  yaw;       // [-1000..+1000]
  uint16_t throttle;  // [0..2000]
  uint16_t crc16;     // CCITT over bytes[0..15]
} stick_frame_t;

#define DRONE_LINK_STICK_SIZE 18

// Size check works in both C11 and C++11.
#if defined(__cplusplus)
static_assert(sizeof(stick_frame_t) == DRONE_LINK_STICK_SIZE,
              "stick_frame_t must be 18 bytes");
#else
_Static_assert(sizeof(stick_frame_t) == DRONE_LINK_STICK_SIZE,
               "stick_frame_t must be 18 bytes");
#endif

// --- CRC-16/CCITT (poly 0x1021, init 0xFFFF, no reflect, no final XOR) -----

static inline uint16_t drone_link_crc16(const uint8_t *data, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= (uint16_t)data[i] << 8;
    for (int b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021)
                           : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

// Fill the crc16 field over bytes[0..15].
static inline void stick_frame_fill_crc(stick_frame_t *f) {
  f->crc16 = drone_link_crc16((const uint8_t *)f, DRONE_LINK_STICK_SIZE - 2);
}

// Verify magic + crc. Does NOT check counter.
static inline int stick_frame_verify(const stick_frame_t *f) {
  if (f->magic != DRONE_LINK_MAGIC) return 0;
  uint16_t want =
      drone_link_crc16((const uint8_t *)f, DRONE_LINK_STICK_SIZE - 2);
  return f->crc16 == want;
}

// --- Dedup helper (RT#9) ---------------------------------------------------
//
// Returns non-zero if `incoming` should be accepted relative to `last_ref`.
// `first_frame` should be non-zero only on the very first call after boot;
// set it to zero after the first acceptance.
// Updates `*last_ref` to max(last_ref, incoming) on accept.

static inline int stick_frame_should_accept(uint32_t incoming,
                                             uint32_t *last_ref,
                                             int first_frame) {
  if (first_frame) {
    *last_ref = incoming;
    return 1;
  }
  // Forward progress within window: accept and advance.
  if (incoming > *last_ref) {
    uint32_t gap = incoming - *last_ref;
    if (gap <= DRONE_LINK_REORDER_FWD) {
      *last_ref = incoming;
      return 1;
    }
    // Forward jump beyond window (e.g., long gap): accept, resync.
    *last_ref = incoming;
    return 1;
  }
  // Backward within reorder tolerance: accept, do NOT advance last_ref.
  // Exact duplicate (back == 0) is rejected — anti-replay.
  uint32_t back = *last_ref - incoming;
  if (back > 0 && back <= DRONE_LINK_REORDER_BACK) {
    return 1;
  }
  // Too old or exact duplicate: reject.
  return 0;
}

// --- Failsafe constant -----------------------------------------------------
// Use stick_frame_make_failsafe() instead of a const global so CRC is always
// fresh (RT#7 follow-up from Security Adversary).

static inline void stick_frame_make_failsafe(stick_frame_t *f,
                                              uint32_t counter) {
  memset(f, 0, sizeof(*f));
  f->magic = DRONE_LINK_MAGIC;
  f->type = DRONE_LINK_TYPE_STICK;
  f->flags = DRONE_LINK_FLAG_FS_SET;  // ARM_REQ cleared
  f->counter = counter;
  f->throttle = 0;
  stick_frame_fill_crc(f);
}

#ifdef __cplusplus
}
#endif
