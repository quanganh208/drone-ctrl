# drone-ctrl (Tiếng Việt)

> Phiên bản tiếng Anh: [README.md](./README.md)

Hệ thống điều khiển drone không dây tự xây dựng. App desktop (Electron) → USB
→ ESP32 #1 (ground station) → ESP-NOW 2.4GHz → ESP32 #2 (gắn trên drone).
Module Air output stick data qua UART để nối tới bất kỳ flight controller nào
— xem [Hướng dẫn kết nối FC](docs/fc-integration-guide.md).

---

## Trạng thái hiện tại

| Thành phần | Tình trạng |
|---|---|
| Wire protocol dùng chung (C + Python + TS, 18 B, CRC16) | ✅ verified byte-level đồng nhất cả 3 ngôn ngữ |
| Firmware ESP32 GCS (USB CDC in, ESP-NOW out) | ✅ hoạt động, tick 100 Hz, watchdog failsafe |
| Firmware ESP32 Air (ESP-NOW in, serial stats out) | ✅ hoạt động, latest-wins slot, dedup |
| App Electron desktop | ✅ verified trên hardware thật |
| Tích hợp FC (CRSF output → bất kỳ FC) | ✅ Air phát CRSF (FC failsafe còn future) — xem [hướng dẫn](docs/fc-integration-guide.md) |

**Đo thực tế** tại 100 Hz trong 30 s (Phase 1 bench):
`loss 0.00% · p50 ≈ 18 ms · p99 ≈ 24 ms` (latency bao gồm ~5-15 ms
buffering của đường serial đo lường, RF thực sẽ nhanh hơn).

---

## Phần cứng

- 2 × ESP32 DevKit (`ESP32-D0WD-V3`, 4 MB flash, CP2102 USB-UART).
  - **GCS**: MAC `cc:7b:5c:fd:0c:f4`, cắm vào laptop host.
  - **Air**: MAC `24:dc:c3:cf:da:10`, sẽ gắn trên drone.
- Anten: PCB ceramic đủ cho bench (< 10 m). Nên thay u.FL + anten rời 3 dBi
  trước khi bay thật.
- **LR mode KHÔNG support** trên chip revision này (verified Phase 1
  preflight). Dùng `WIFI_PHY_RATE_1M_L` — lựa chọn robust nhất available.

Mã hoá ESP-NOW **đang disable** — xem §Tech Debt. Chỉ chạy link này trong
môi trường RF sạch do bạn kiểm soát.

---

## Cấu trúc thư mục

```
drone-ctrl/
├── shared/                      # wire protocol — single source of truth
│   ├── drone-link-protocol.h    # C header, 18 B struct + CRC16 + dedup
│   ├── drone-link-protocol.py   # Python mirror
│   ├── test-protocol-roundtrip.py
│   ├── link-config-local.h.example  # template PMK/LMK/AP
│   └── link-config-local.h      # gitignored, secrets local
├── smoke-preflight/             # sketch chẩn đoán Phase 1 (LR mode probe)
│   └── smoke-preflight.ino
├── gcs-esp32/                   # firmware ground-station (ESP32 #1)
│   ├── gcs-esp32.ino
│   └── gcs-core.h/.cpp
├── air-esp32/                   # firmware cạnh drone (ESP32 #2)
│   ├── air-esp32.ino
│   └── air-core.h/.cpp
├── app-electron/                # UI điều khiển desktop (React + TS)
│   ├── src/
│   │   ├── main/                # node process: SerialTransport, IPC
│   │   ├── preload/             # typed window.drone contextBridge
│   │   ├── shared/              # TS port của drone-link-protocol
│   │   └── renderer/src/        # React UI
│   └── package.json
├── tools/                       # helper Python / bash chạy trên host
│   ├── bench-link-latency.py    # đo loss + latency
│   └── run-bench.sh             # one-shot bench runner
├── README.md                    # tiếng Anh
└── README.vi.md                 # bạn đang đọc
```

Tài liệu plan + integration reports ở
`plans/260408-2310-esp32-link-foundation/` và
`plans/260409-0920-phase2-electron-app/`.

---

## Chuẩn bị môi trường

### Một lần cho mỗi máy

```bash
# 1. Cài arduino-cli (user-local, không cần sudo)
curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
  | BINDIR="$HOME/.local/bin" sh
export PATH="$HOME/.local/bin:$PATH"

# 2. Cài ESP32 core
arduino-cli core update-index \
  --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
arduino-cli core install esp32:esp32@3.3.7

# 3. Node 20+ (cho app Electron)
node --version    # phải là v18.18 hoặc mới hơn
```

### Một lần cho mỗi clone repo

```bash
# 4. Tạo config local với secret random
cd drone-ctrl/shared
cp link-config-local.h.example link-config-local.h
# Sửa link-config-local.h, điền PMK/LMK bằng bytes random + password WiFi
# AP 20+ ký tự nếu định bật encryption sau. Mặc định đã random rồi nhưng
# ĐỪNG tin — regenerate trước khi deploy.

# 5. Cài dependencies cho app Electron
cd ../app-electron
npm install       # tự động rebuild serialport native binding
```

### Permission user

Đảm bảo user thuộc group `dialout` để mở `/dev/ttyUSB*` không cần sudo:

```bash
groups $USER | grep -q dialout || sudo usermod -aG dialout "$USER"
# log out + log in lại nếu vừa thêm
```

---

## Xác định ESP32 nào là GCS, nào là Air

Cả 2 board CP2102 đều hiện `Silicon Labs` nên `nmcli` / `arduino-cli board list`
không phân biệt được. Dùng `by-path` (dựa vào cổng USB vật lý):

```bash
ls -l /dev/serial/by-path/ | grep ttyUSB
# pci-...usb-0:9:1.0-port0    → ttyUSB? → GCS (MAC cc:7b:5c:fd:0c:f4)
# pci-...usb-0:11.2:1.0-port0 → ttyUSB? → AIR (MAC 24:dc:c3:cf:da:10)
```

Link `by-path` ổn định qua reboot chừng nào bạn cắm mỗi ESP32 vào cùng cổng
USB.

Tiện nhất là export 2 biến ở đầu terminal debug:

```bash
export GCS_PORT=/dev/serial/by-path/pci-0000:00:14.0-usb-0:9:1.0-port0
export AIR_PORT=/dev/serial/by-path/pci-0000:00:14.0-usb-0:11.2:1.0-port0
```

Chỉnh prefix `pci-...` cho khớp với máy bạn.

---

## Flash firmware

```bash
cd drone-ctrl
export PATH="$HOME/.local/bin:$PATH"

# GCS (dùng USB CDC nhận stick từ host, ESP-NOW đẩy đi Air)
arduino-cli upload -p "$GCS_PORT" --fqbn esp32:esp32:esp32 gcs-esp32

# Air (nhận ESP-NOW, in stats + decoded channels ra serial)
arduino-cli upload -p "$AIR_PORT" --fqbn esp32:esp32:esp32 air-esp32
```

**Lưu ý**: FQBN là `esp32:esp32:esp32` trên Arduino-ESP32 core 3.x. Cái cũ
`esp32:esp32:esp32dev` không còn tồn tại và sẽ fail.

### Verify firmware chạy

```bash
~/.claude/skills/.venv/bin/python3 -c "
import serial, time
s = serial.Serial('$GCS_PORT', 115200, timeout=0.3, dsrdtr=False)
time.sleep(0.3)
for _ in range(20):
    l = s.readline().decode(errors='ignore').rstrip()
    if '[gcs]' in l: print('GCS:', l); break
"
# Kỳ vọng: GCS: [gcs] CH=6 RX=0 OK=0 BAD=0 | TX=... OK=... FAIL=... | AGE_us=0
```

Làm tương tự với Air nhưng tìm `'[air]'` / `STATS`.

---

## Chạy bench link-only (chưa có GUI)

Dùng để kiểm tra đường wire trước khi mở app Electron.

```bash
cd drone-ctrl
~/.claude/skills/.venv/bin/python3 tools/bench-link-latency.py \
  --gcs "$GCS_PORT" \
  --air "$AIR_PORT" \
  --rate 100 --duration 30
```

Kết quả kỳ vọng:
```
Sent:     3001
Air ACC:  3001  (from STATS delta — ground truth)
Loss:     0.00%
Latency:  p50=~18ms  p99=~24ms
Gate loss<0.5%: PASS
Gate p99<25ms:  PASS
OVERALL:        PASS
```

Nếu ACC ≠ Sent, check kênh (phải là 6 cả 2 bên), nguồn, và vị trí anten.

---

## Chạy app Electron điều khiển

### Start dev mode

```bash
cd drone-ctrl/app-electron
npm run dev:no-sandbox
```

`dev:no-sandbox` set `ELECTRON_DISABLE_SANDBOX=1` để bypass lỗi SUID
sandbox trên Linux. Nếu muốn fix "đúng bài":

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
npm run dev
```

### Dùng UI

1. **Port selector** (góc trên bên phải) → chọn tty của GCS (vd `/dev/ttyUSB0`).
   Click **Connect**. Dot sẽ xanh.
2. Đợi ~1 giây. Link HUD sẽ populate số thật
   (`CH 6 · TX ... · OK ... · LOSS 0.00%`). Nếu banner đỏ vẫn hiện, xem
   Troubleshooting.
3. **Joystick widgets** dùng pointer events (chuột / touch). Stick trái
   điều khiển yaw, stick phải điều khiển roll + pitch. **Throttle slider**
   cap ở 50 % do cờ `BENCH_MODE = true` trong
   `src/renderer/src/components/throttle-slider.tsx`.
4. **Keyboard** alternate: WASD = pitch/roll, ←→ = yaw, ↑↓ = throttle,
   **Space** = yêu cầu ARM, **Esc** = STOP.
5. **ARM**: giữ nút ARM đỏ 2 giây với throttle = 0. Có countdown vàng
   hiện ra; thả tay hoặc tăng throttle sẽ hủy. Khi đạt 200 frames liên
   tiếp → state chuyển sang ARMED (xanh).
6. **STOP**: click nút STOP đỏ (hoặc phím Esc). Main process đẩy 10
   failsafe frames trực tiếp, rồi lock UI 3 giây.

### Xem backend

Trong terminal chạy `npm run dev:no-sandbox` bạn sẽ thấy:

```
[transport] stty applied: 115200 raw -hupcl clocal
[transport] guard fd opened (nonblock+noctty)
[transport] post-open flush complete, attaching data listener
[transport] raw chunk 1: "[" ...
[transport] line 1: "[gcs] CH=6 RX=99 OK=99 BAD=0 | TX=... OK=... FAIL=..."
```

RX counter tăng = stick frames đang tới GCS. OK counter tăng = ESP-NOW tới
Air thành công.

---

## Chạy test TypeScript

```bash
cd drone-ctrl/app-electron
npm test            # 21 tests (protocol + telem parser)
npm run typecheck
npm run build       # build full main + preload + renderer
```

Cả 3 phải pass trong CI. Protocol tests cross-verify byte-level với Python
mirror qua golden vector.

---

## Troubleshooting (những bug đã gặp)

### "App không xuất hiện" — sandbox error trên Linux

```
The SUID sandbox helper binary was found, but is not configured correctly...
```

Dùng `npm run dev:no-sandbox` hoặc chạy command `sudo chown + chmod 4755` ở
trên. Đây là quirk first-run của Linux, không phải bug của app.

### Serial có byte "rác" sau khi Connect (hex kiểu `3b 72 db ...`)

Auto-reset circuit của ESP32 DevKit đã fire khi Electron mở port. Code
`SerialTransport.connect()` đã có workaround guard-fd, nhưng yêu cầu:
- `stty` phải available trong $PATH
- User phải có quyền `fs.open` tty

Nếu thấy rác:

1. Kiểm tra terminal log có `[transport] stty applied` và
   `[transport] guard fd opened (nonblock+noctty)` không. Thiếu một trong
   hai → fix permissions.
2. Reflash firmware GCS (`arduino-cli upload ...`) và thử lại — reset
   nhiều lần có thể đẩy ESP32 vào crash loop.
3. Verify GCS in text sạch bằng oneliner pyserial phía trên. Nếu pyserial
   thấy text nhưng Electron thấy rác, báo bug.

### Link HUD stuck "waiting for GCS telemetry…"

- Đảm bảo bạn đã chọn port GCS, không phải Air. Cả 2 đều Silicon Labs.
  Dùng `by-path` để phân biệt.
- Reflash GCS. Serial output phải bắt đầu trong ~1 giây sau boot.
- Trong dev terminal, tìm `[transport] line 1: "[gcs] ..."`. Nếu thấy raw
  chunks nhưng không thấy parsed line, regex stats đã đổi và cần update
  `src/main/telem-parser.ts`.

### Banner "GCS TELEMETRY LOST" sau khi connect

Cùng root cause như trên — đường serial đang nhận rác hoặc im lặng > 2s.
Disconnect, reflash GCS, reconnect.

### ESP-NOW TX OK = 0, FAIL tăng

Air hoặc offline, đang boot loop, hoặc ở sai channel. Reflash Air và xác
nhận in được `[air] STATS CH=6 ... [OK]` (không phải `[FAILSAFE]`) qua
pyserial.

### Lỗi `arduino-cli` FQBN: `board esp32:esp32:esp32dev not found`

Arduino-ESP32 core 3.x đã đổi tên generic board thành `esp32:esp32:esp32`.
Dùng đúng chuỗi này.

### Cả 2 ESP32 có cùng `serialNumber 0001`

Clone CP2102 boards share serial → udev không build được `by-id` symlink
ổn định. Dùng `by-path` thay thế (dựa vào cổng USB vật lý).

### ⚠️ KHÔNG mở Arduino IDE Serial Monitor cùng lúc với app Electron

Arduino IDE Serial Monitor và Electron `serialport` không chơi chung được.
Arduino IDE sẽ:
- Mess termios settings của tty (baud, flags) khiến Electron không parse được
- Giành bytes từ cùng port → race condition, data loss

Nếu cần monitor serial trong lúc Electron chạy:
- Dùng một ESP32 khác với cùng firmware
- Hoặc dùng pyserial trên port Air (không conflict với Electron trên port GCS)
- Hoặc dùng strace/ltrace để trace system calls của Electron

Nếu lỡ mở Arduino IDE:
```bash
pkill -9 arduino-ide
stty -F /dev/ttyUSB0 115200 raw -echo cs8 -parenb -cstopb -hupcl clocal -ixon -ixoff -crtscts
stty -F /dev/ttyUSB1 115200 raw -echo cs8 -parenb -cstopb -hupcl clocal -ixon -ixoff -crtscts
# Rồi disconnect + reconnect trong Electron
```

---

## Tech debt (nợ kỹ thuật)

| Vấn đề | Tác động | Track ở |
|---|---|---|
| ESP-NOW encryption đang disable | Bất kỳ ESP32 gần trong RF range với MAC match có thể inject frames. Chỉ bench dùng được. | Phase 1 report |
| Serial path làm tăng giả latency đo lường | p99 RF thực có lẽ 10-15 ms, không phải 24 ms đo được | Phase 1 report |
| `BENCH_MODE` cap throttle là hardcoded | Phải recompile để raise trên 50 % | `throttle-slider.tsx` |
| Chưa có attitude HUD (artificial horizon) | Cần Air → GCS telemetry echo | Defer đến Phase 3 |
| Chỉ test trên Linux | Chưa thử Windows `COM*` path + termios handling | — |
| MAC peer hardcoded | Không thể swap ESP32 mà không rebuild | `link-config-local.h` |

---

## Roadmap

- **Phase 3 — FC firmware** (developer khác). CRSF parser, angle PID, motor
  mixer quad-X, ARM state machine, failsafe. Xem hướng dẫn kết nối.
- **Phase 4 — Integration + tethered flight**. Nối UART của Air ESP32 vào
  USART1 của FC, bench test không có cánh quạt, rồi tethered hover.

Mỗi phase có chu trình riêng brainstorm → plan → implement. Xem templates
trong `plans/`.

---

## Lịch sử debug (cho ai đi sau)

Session này đã hit 4 tầng bug trước khi link end-to-end chạy được:

1. **LR mode `ESP_FAIL` trên classic ESP32-D0WD-V3** → locked xuống `1M_L`
2. **SoftAP + ESP-NOW coexistence corruption** trên Arduino-ESP32 3.3.7 →
   pivot architecture: bỏ WiFi cho host↔GCS, dùng USB CDC serial thay thế
3. **ESP-NOW encryption drop frames im lặng** trên core 3.3.7 → disable
   encryption (tech debt)
4. **ESP32 reset trên `serialport.open()`** do DTR/RTS auto-reset circuit →
   guard fd với `O_NONBLOCK | O_NOCTTY` trick

Các fix này đều có code trong `gcs-esp32/gcs-core.cpp` và
`app-electron/src/main/serial-transport.ts` với comment `WORKAROUND:` /
`KEY WORKAROUND:`. Đừng xoá khi refactor mà chưa hiểu tại sao chúng tồn
tại.

---

## Giấy phép / an toàn

**TẠM THÁO CÁNH QUẠT ĐẾN HẾT PHASE 4.** Cho đến khi FC firmware có CRSF
parser + angle PID + mixer + arm state machine + failsafe, motor
**tuyệt đối không được gắn vào airframe**. Cờ `BENCH_MODE` của app
enforce cap throttle 50% nhưng không phải hardware-level — hãy coi đó là
hint mềm, không phải safety device.

Đây là project nghiên cứu cá nhân. Không bảo hành. Đọc code trước khi
nối bất cứ thứ gì có thể cắt vào ngón tay.
