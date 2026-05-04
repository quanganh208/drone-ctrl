# Nguyên lý hoạt động

> English: [how-it-works.md](how-it-works.md)

Tổng quan kỹ thuật hệ thống drone-ctrl — từ joystick trên laptop đến dữ liệu
stick trên drone, sẵn sàng nối tới bất kỳ flight controller nào.

---

## Kiến trúc hệ thống

```
┌──────────────┐     USB      ┌──────────┐    ESP-NOW     ┌──────────┐    UART     ┌──────┐
│  Electron    │   serial     │  ESP32   │   2.4 GHz      │  ESP32   │   CRSF     │  FC  │
│  App         │ ───────────▶ │  GCS     │ ──────────────▶ │  Air     │ ─────────▶ │(bất  │
│  (laptop)    │   18 bytes   │  #1      │    18 bytes    │  #2      │  0x16 RC   │ kỳ)  │
│              │   @ 100 Hz   │          │  @ 100 Hz ×2   │  (drone) │  @ ~143 Hz │      │
└──────────────┘              └──────────┘                └──────────┘            └──────┘
     ✅ Xong                     ✅ Xong                     ✅ Xong              ✅ Xong
```

Hệ thống có **4 hop đã hoàn thành** (App → GCS → Air → FC) truyền lệnh stick
từ UI desktop tới flight controller ở 100 Hz upstream và ~143 Hz trên dây CRSF.
Hop thứ 4 (Air → FC qua CRSF UART) đã **implement** — xem
[fc-integration-guide.md](fc-integration-guide.md). Failsafe timeout phía FC
(không nhận CRSF > 500 ms → disarm) vẫn còn future, xem §Hạn chế.

---

## Hop 1 — App Electron → ESP32 GCS (USB serial)

### Chuyện gì xảy ra

1. User kéo joystick hoặc nhấn phím (WASD, mũi tên).
2. **Zustand store** (React) giữ stick state hiện tại: roll, pitch, yaw,
   throttle, arm request.
3. Tick **requestAnimationFrame** ~50 Hz đọc store, gửi IPC tới main process.
4. Main process duy trì **latest-wins slot** — chỉ giữ state mới nhất, cũ bị
   ghi đè.
5. **setInterval 100 Hz** đọc slot, tạo counter tăng dần, pack dữ liệu vào
   frame 18 bytes, ghi ra USB serial.
6. Nếu slot cũ > 200 ms (user ngừng gửi), main process tự inject **failsafe
   frame** (throttle = 0, arm = 0).

### Tại sao USB serial thay vì WiFi?

Ban đầu thiết kế dùng WiFi SoftAP + UDP cho App ↔ GCS. Khi bench test Phase
1, phát hiện **ESP-NOW và SoftAP không thể cùng tồn tại ổn định** trên ESP32
classic (chip radio đơn). SoftAP beacon cạnh tranh airtime với ESP-NOW:
- Ping RTT nhảy từ 2 ms lên 1000+ ms
- ESP-NOW TX thành công rớt xuống 59%
- Air module boot loop dưới tải

**Giải pháp**: bỏ SoftAP. Laptop nối GCS qua USB. Radio ESP32 dành 100% cho
ESP-NOW — không còn xung đột.

### Trick guard FD chống reset

Trên Linux, mở tty làm DTR toggle → kích hoạt mạch auto-reset của DevKit
ESP32. Để GCS không reboot mỗi lần app connect:
1. Chạy `stty -hupcl clocal` trước khi mở port.
2. Mở **guard file descriptor** với `O_RDONLY | O_NONBLOCK | O_NOCTTY` trước
   khi serialport library mở. Linux tty chỉ toggle DTR lần mở đầu tiên —
   guard FD hấp thụ lần đó, serialport library mở thứ hai không đụng DTR.

---

## Hop 2 — ESP32 GCS → ESP32 Air (ESP-NOW RF)

### Chuyện gì xảy ra

1. GCS firmware có **tick task 100 Hz** (FreeRTOS) đọc stick frame mới nhất
   từ buffer USB serial input.
2. Nếu frame cũ > 200 ms hoặc chưa có frame → thay bằng **failsafe frame**.
3. Frame gửi qua **ESP-NOW unicast** tới MAC address của Air.
4. Mỗi frame gửi **2 lần** (redundancy ×2) để 1 lần mất gói không gây gap.
5. ESP-NOW có hardware ACK + 1 retry tự động ở lớp radio.

### Cấu hình ESP-NOW

| Tham số | Giá trị | Lý do |
|---|---|---|
| Mode | STA (không AP) | Radio dành hết cho ESP-NOW |
| PHY rate | `WIFI_PHY_RATE_1M_L` | Robust nhất available (LR mode không support ESP32 classic) |
| Channel | 6 (cố định) | 2 con lock cùng kênh |
| TX power | 21 dBm (max) | Range tốt nhất |
| Power save | Tắt (`WIFI_PS_NONE`) | Latency thấp nhất |
| Mã hóa | Tắt (tech debt) | ESP-NOW encryption drop frame im lặng trên core 3.3.7 |

### Tại sao không dùng Long Range mode?

Preflight probe Phase 1 xác nhận `WIFI_PHY_RATE_LORA_250K` trả `ESP_FAIL`
trên cả 2 board ESP32-D0WD-V3. LR mode **không có** trên chip revision này.
Dùng 1 Mbps Long Preamble. Range ~50 m LOS (đủ cho bench + bay gần).

---

## Hop 3 — ESP32 Air nhận và giải mã

### Chuyện gì xảy ra

1. **ESP-NOW receive callback** fire khi frame tới từ MAC GCS.
2. Frame được validate: magic bytes (`0xA5C3`), CRC-16/CCITT, window-based
   dedup (reject duplicate/stale counter).
3. Frame hợp lệ update **latest-wins slot** bảo vệ bởi `portMUX` critical
   section (an toàn cross-core).
4. **Task in serial 50 Hz** output giá trị đã decode ra USB cho debug
   monitoring. Output debug này KHÔNG đi tới flight controller — chỉ cho
   development.

### Dedup và anti-replay

Mỗi frame mang counter `uint32` tăng dần. Air track counter cuối cùng đã
accept và áp dụng window-based:

- Nhảy tới (counter > last): accept, cập nhật last.
- Lùi trong 3 (reorder tolerance): accept, không advance last.
- Trùng chính xác (counter == last): **reject** (anti-replay).
- Lùi > 3: reject (quá cũ).

Ngăn attacker replay frame đã capture + bảo vệ khỏi out-of-order từ
redundancy ×2.

---

## Wire protocol — stick frame 18 bytes

Mọi hop dùng cùng format binary 18 bytes:

```
Offset  Kiểu      Tên        Mô tả
──────  ────────  ─────────  ──────────────────────────────
0..1    uint16    magic      Luôn 0xA5C3 (frame sync)
2       uint8     type       0x01 = STICK
3       uint8     flags      bit0 = ARM_REQ, bit3 = FAILSAFE
4..7    uint32    counter    Tăng dần, cho dedup + anti-replay
8..9    int16     roll       [-1000 .. +1000]
10..11  int16     pitch      [-1000 .. +1000]
12..13  int16     yaw        [-1000 .. +1000]
14..15  uint16    throttle   [0 .. 2000]
16..17  uint16    crc16      CRC-16/CCITT trên bytes [0..15]
```

- **Little-endian** (khớp ESP32 + x86).
- **CRC-16/CCITT**: poly 0x1021, init 0xFFFF, không reflect, không final XOR.
- **Đồng nhất trên mọi hop** — GCS relay frame nguyên trạng (chỉ tạo counter
  và CRC mới).

Source of truth: `shared/drone-link-protocol.h` (C), mirror trong
`shared/drone-link-protocol.py` (Python) và
`app-electron/src/shared/protocol.ts` (TypeScript).

---

## Pattern latest-wins slot

Pattern thiết kế cốt lõi dùng trên mọi node:

```
Writer (bất kỳ tần suất)          Reader (tần suất cố định)
────────────────────────          ─────────────────────────
nhận frame mới ──▶ [1 slot] ◀── timer tick đọc slot
                   (ghi đè)      mỗi 10 ms (100 Hz)
```

**Chỉ giá trị mới nhất có ý nghĩa.** Frame cũ bị hủy im lặng. Không queue,
không FIFO, không backlog. Vì lệnh stick là **positional** — chỉ vị trí hiện
tại của joystick mới quan trọng.

Lợi ích:
- Không tích tụ latency (không có queue depth)
- Bộ nhớ cố định (1 slot, không phải N)
- Miễn nhiễm rate mismatch producer/consumer
- Concurrency đơn giản (mutex trên 1 slot)

---

## Chuỗi failsafe — 3 tầng độc lập

Mỗi tầng hoạt động độc lập. Nếu link phía trên chết, node phía dưới phát
hiện bằng timeout và tự bảo vệ.

```
Tầng 1: App → GCS
  Trigger: không có stick update từ renderer > 200 ms
  Hành động: main process inject failsafe frame (throttle=0, arm=0)
  Kết quả: GCS forward failsafe tới Air, drone cắt throttle

Tầng 2: GCS → Air
  Trigger: Air không nhận ESP-NOW frame hợp lệ > 500 ms
  Hành động: slot Air stale, serial hiện [FAILSAFE]
  Kết quả: Air phát CRSF với throttle=172, ARM=172 tới FC

Tầng 3: Air → FC (tương lai, phía FC)
  Trigger: FC không nhận CRSF frame hợp lệ > 500 ms
  Hành động: FC cắt PWM motor, disarm
  Kết quả: motor dừng, drone hạ xuống
```

**Tầng 1–2 đã hoạt động**: app crash → GCS watchdog fire ở 200 ms. GCS crash →
Air watchdog fire ở 500 ms và Air bắt đầu phát CRSF safe values. **Tầng 3 vẫn
future** — STM32 parser tại `Core/Src/main.c` chưa enforce CRSF timeout, nên
Air hard-fault (firmware crash, mất nguồn) sẽ làm FC giữ channel cuối cùng.
Bắt buộc xong trước khi tethered flight.

---

## Cổng an toàn ARM

Arming (cho phép motor quay) yêu cầu **hành động có chủ đích**:

1. User nhấn giữ nút ARM (hoặc phím Space) **đủ 2 giây**.
2. Throttle phải **đúng 0** suốt 2 giây giữ.
3. Thả nút hoặc đụng throttle → counter reset về 0.
4. Đồng hồ 2 giây dùng **wall-clock time** (`Date.now()`), không đếm tick,
   nên không bị ảnh hưởng bởi event loop jitter.
5. Khi đã armed, state **dính** — thả nút không disarm.
6. Để disarm: click nút **DISARM** (hoặc Shift+Space).
7. Khẩn cấp: click **STOP** (hoặc Escape) → 10 failsafe frames gửi ngay +
   UI lock 3 giây.

State machine ARM sống trong **Electron main process** — renderer không thể
bypass.

---

## Hiệu năng đo được

Benchmark 100 Hz trong 30 giây (Phase 1, USB serial transport):

| Chỉ số | Giá trị |
|---|---|
| Frames gửi | 3001 |
| Frames Air nhận | 3001 (0.00% mất gói) |
| Latency p50 | ~18 ms * |
| Latency p99 | ~24 ms * |
| Max | 78 ms * |
| Jitter (stddev) | 3.8 ms |

\* Latency bao gồm ~5–15 ms USB-CDC serial buffering trong đường đo. Latency
RF thực ước tính 5–10 ms.

---

## Hạn chế và tech debt

| Vấn đề | Trạng thái |
|---|---|
| ESP-NOW encryption | Tắt — drop frame im lặng trên Arduino-ESP32 3.3.7 |
| CRSF output từ Air | ✅ Đã có — UART2 GPIO17 @ 420000 baud, type 0x16 @ ~143 Hz |
| FC-side CRSF failsafe timeout | Chưa có — STM32 parser giữ channel cuối khi mất Air |
| Telemetry ngược | Chưa có — FC không gửi data ngược về app được |
| WiFi SoftAP transport | Bỏ — không ổn định với ESP-NOW trên single-radio ESP32 |
| Đo latency | Bị ô nhiễm bởi serial path; cần UDP echo cho số RF-only |
