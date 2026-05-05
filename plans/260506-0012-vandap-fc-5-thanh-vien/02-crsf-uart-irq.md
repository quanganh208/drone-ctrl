# Người B — Parser CRSF + USART RX-Interrupt

## Scope

| | |
|---|---|
| **File** | `Core/Src/stm32f4xx_it.c:399–484` (USART1_IRQHandler), `Core/Src/usart.c:29–76` (init) |
| **Hàm chính** | `USART1_IRQHandler()`, `crsf_crc8()`, `crsf_calc_crc()`, `Decode_RxElrs()` |
| **Vai trò** | Đọc tín hiệu điều khiển từ ELRS receiver (từ tay điều khiển hoặc từ ESP32 Air) |
| **Output** | `crsf_channel[16]` + cờ `crsf_frame_done` cho `RX_PROCESS()` đọc |

## Phải biết cold

### 1. CRSF là gì
- **CRSF (Crossfire Serial Protocol)** — chuẩn của TBS Crossfire / ELRS, kế thừa SBUS.
- 16 channel × 11 bit = 176 bit packed → 22 byte payload.
- Frame rate cao: 250 / 500 / 1000 Hz (ELRS), latency thấp (<5 ms end-to-end).
- Dùng UART **inverted-NOT** (level standard), baudrate **420 000 bps**.

### 2. Cấu trúc 1 frame CRSF
```
┌─────────┬────────┬──────┬─────────────────┬──────┐
│ ADDRESS │ LENGTH │ TYPE │   PAYLOAD       │ CRC8 │
│ 1 byte  │ 1 byte │ 1 B  │ (LENGTH-2) byte │ 1 B  │
└─────────┴────────┴──────┴─────────────────┴──────┘
   0xC8       N      0x16    22 byte cho RC      polynomial 0xD5
   (FC)
```
- ADDRESS = `0xC8` cho FC, `0xEA` cho radio.
- LENGTH = số byte sau LENGTH (gồm TYPE + payload + CRC).
- TYPE quan trọng: `0x16` = RC_CHANNELS_PACKED, `0x14` = LINK_STATISTICS.
- CRC8 polynomial **0xD5** (CRC-8/DVB-S2), tính từ TYPE đến hết payload.

### 3. Cấu hình UART trên project (`usart.c:29`)
```c
USART1: BaudRate = 420000, 8N1, RX-only IT
        NVIC priority 3 (thấp hơn USART2 = 1, nhưng đủ vì CRSF ~1 ms 1 frame)
        LL_USART_EnableIT_RXNE(USART1)  // bật ngắt RXNE
        Chân: PA9 = TX, PA10 = RX
```

### 4. State machine trong ISR (3 state)

```c
switch (crsf_cnt) {
  case 0:  // chưa thu được byte nào → byte này = ADDRESS
  case 1:  // đã có ADDRESS → byte này = LENGTH; reject nếu > 62
  default: // tích lũy payload, khi đủ (LENGTH+2 byte) → check CRC + decode
}
```

### 5. Resync timeout
```c
if ((TIM2->CNT - crsf_last_time) > 2000) crsf_cnt = 0;
```
- TIM2 đếm 1 µs/tick → 2000 = **2 ms** im lặng → reset state.
- Vì sao cần? Nếu mất 1 byte giữa frame, không reset thì state machine kẹt cho đến khi gặp ngẫu nhiên byte có giá trị `0xC8` ở vị trí ADDRESS → corrupt.

### 6. Bit-unpack 11-bit channels
22 byte payload → 16 channel × 11 bit. Mỗi channel kéo dài 11 bit, không align byte.

```c
crsf_channel[0] = ((p[0] | p[1]<<8) & 0x07FF);
crsf_channel[1] = ((p[1]>>3 | p[2]<<5) & 0x07FF);
crsf_channel[2] = ((p[2]>>6 | p[3]<<2 | p[4]<<10) & 0x07FF);
// ...
```
- Mặt nạ `0x07FF` = 11 bit thấp (0..2047).
- Giá trị raw 172..1811 ↔ stick range −100% .. +100%.
- Trung điểm ~991, dùng làm offset trong `RX_PROCESS` (`OFFSET_CH[]`).

## Code walkthrough — USART1_IRQHandler

```c
void USART1_IRQHandler(void)
{
  if (LL_USART_IsActiveFlag_RXNE(USART1)) {
    datarx = LL_USART_ReceiveData8(USART1);  // (1) đọc + tự clear RXNE
    LL_USART_ClearFlag_RXNE(USART1);          // (2) bảo hiểm
    if ((TIM2->CNT - crsf_last_time) > 2000) crsf_cnt = 0;  // (3) timeout
    crsf_last_time = TIM2->CNT;
    /* state machine ... */
  }
  if (LL_USART_IsActiveFlag_ORE(USART1)) {    // (4) overrun → clear
    LL_USART_ClearFlag_ORE(USART1);
  }
}
```

**Điểm chốt:**
- (1) đọc DR clear cờ RXNE; (2) là defensive double-clear.
- (4) **bắt buộc** xử lý ORE — nếu không, ISR sẽ kẹt vĩnh viễn (RXNE không tự update khi ORE active).
- ISR **không** decode trong default-case nếu chưa đủ byte → tránh làm dài ISR.

## Câu hỏi CƠ BẢN

| # | Câu | Hướng trả lời |
|---|---|---|
| 1 | "UART vs SPI khác gì?" | UART async, 1-1, không clock chung; SPI sync, 1-N, có CS |
| 2 | "Baudrate 420000 nghĩa là gì?" | Tốc độ truyền 420 000 bit/s; mỗi byte 10 bit (1 start + 8 data + 1 stop) → ~24 µs/byte |
| 3 | "RXNE là cờ gì?" | RX Not Empty — set khi có byte nhận xong, đọc DR sẽ tự clear |
| 4 | "Tại sao cần ngắt thay vì poll?" | CRSF 250–500 Hz, byte tới mỗi 24 µs — main loop polling sẽ bỏ lỡ |
| 5 | "ISR phải ngắn — vì sao?" | Block ISR khác cùng/dưới priority; có thể overflow byte sau (ORE) |
| 6 | "CRC8 polynomial 0xD5 nghĩa là gì?" | Đa thức `x⁸+x⁷+x⁶+x⁴+x²+1` — CRC-8/DVB-S2, chuẩn CRSF |
| 7 | "16 channel × 11 bit = 176 bit, sao dồn vào 22 byte?" | 176/8 = 22 chính xác — packed bit-stream, không align |
| 8 | "Tại sao TYPE = 0x16 quan trọng?" | Project chỉ decode RC_CHANNELS_PACKED; LINK_STATISTICS (0x14) đang comment-out |

## Câu hỏi PHẢN BIỆN

### Q1. "Em xử lý parsing TRONG ISR — có an toàn không?"
**A:** Một phần ổn (chỉ tích lũy + ghi mảng), nhưng **đoạn bit-unpack 16 channel khá dài** (~50 dòng). Trên Cortex-M4 96 MHz chạy hết ~5 µs, vẫn ngắn hơn thời gian giữa 2 byte (24 µs). **Phương án sạch hơn**: ISR chỉ tích lũy vào ring buffer, decode + CRC trong main loop.

### Q2. "Nếu mất 1 byte ở giữa, state machine xử lý sao?"
**A:** Frame hiện tại sai LENGTH/CRC → CRC fail → bỏ frame. Frame sau nếu cách >2 ms thì timeout reset về case 0; nếu <2 ms thì state machine có thể nhận `crsf_cnt=2` với byte đầu của frame mới → vẫn fail CRC → 1 frame nữa cũng mất, đến khi timeout. **Recovery max 2 frame loss**.

### Q3. "CRC8 không phát hiện hết lỗi bit. Tại sao không dùng CRC16/32?"
**A:** Trade-off bandwidth vs detection. CRSF chuẩn dùng CRC8 vì:
- Frame ngắn (< 64 byte) → CRC8 đủ phát hiện burst error ≤ 8 bit.
- Tiết kiệm 1 byte/frame ở 500 Hz = 500 byte/s.
- Lỗi bị bỏ qua sẽ bị filter bằng LPF `alpha_lpf_rx` ở `RX_PROCESS` (line 642).

### Q4. "NVIC priority 3 cho USART1 — vì sao thấp hơn USART2 (priority 1)?"
**A:** CRSF tới mỗi 2 ms (500 Hz), không quá gấp; USART2 chưa dùng nhưng config priority cao đề phòng cho telemetry. **Thực tế** project chưa quyết hẳn, đây là trade-off có thể cải thiện.

### Q5. "Nếu CRC đúng nhưng giá trị channel sai (ví dụ stick bị spike)?"
**A:** CRC chỉ verify integrity transport, không filter giá trị. Project xử ly bằng:
- LPF α=0.92 trong `RX_PROCESS` line 642 → spike bị làm mượt.
- Throttle có offset `OFFSET_CH[2] = 172.0` (giá trị min CRSF) → nhỏ hơn không tăng motor.

### Q6. "ORE mà không clear thì sao?"
**A:** ORE = Overrun Error: byte mới đè byte chưa kịp đọc. RXNE không set thêm cho byte mới → ISR im lặng → drone mất tín hiệu. Phải clear bằng cách đọc SR rồi DR (HAL/LL có macro `LL_USART_ClearFlag_ORE`).

### Q7. "Tại sao lại dùng LL không phải HAL?"
**A:** HAL UART có lớp wrapper, mỗi byte phải qua callback `HAL_UART_RxCpltCallback` và quản lý `huart->RxXferCount` — overhead ~10× LL. CRSF byte tới 24 µs/byte, HAL có thể trễ → dùng LL là quyết định đúng.

### Q8. "11-bit unpack — em hiểu công thức `(p[0] | p[1]<<8) & 0x07FF` không?"
**A:**
- `p[0]` chiếm bit 0..7 của channel 0.
- `p[1]<<8` cộng tiếp bit 8..15 (nhưng chỉ dùng tới bit 10 vì 11-bit).
- `& 0x07FF` mask 11 bit thấp.
- Channel 1 bắt đầu ở bit 11 (= byte 1 bit 3) → `p[1]>>3 | p[2]<<5`.
- Tổng quát: dồn 11 bit packed thành stream, đọc cửa sổ 11 bit trượt.

## Bẫy thường gặp

1. **Quên clear ORE** → ISR khóa cứng, mất tín hiệu, drone đứng motor cố định.
2. **Đọc DR 2 lần** → mất byte (DR là FIFO 1 phần tử — read pop).
3. **`crsf_len > 62`** không check → buffer overflow, crash hard fault.
4. **Endianness ngược** trong unpack → channel sai hoàn toàn.
5. **Quên `volatile` cho `crsf_frame_done`** → main loop optimize away kiểm tra cờ.
6. **CRSF ELRS có inverted UART** trên một số receiver → cần phần cứng inverter, hoặc ELRS firmware đã invert sẵn.

## "Nếu bỏ module này thì sao?"

→ Không có CH[16] → ARM_Status không bao giờ ARM → motor luôn đứng im. Hoặc nếu CH[] có rác, drone tự nhận lệnh ngẫu nhiên → mất kiểm soát.

## Bonus — câu hỏi mở rộng

- Vẽ timing diagram 1 byte UART (start + 8 data + stop) ở 420000 bps.
- Tại sao CRSF dùng 420000 mà không phải baud chuẩn 115200?  → Latency. ELRS yêu cầu < 5 ms đầy đủ chu trình.
- Khác biệt CRSF vs SBUS vs IBUS?
  - SBUS: 100000 bps inverted, 25 byte/frame, 14ms.
  - IBUS: 115200 bps, 32 byte, 7 ms.
  - CRSF: 420000 bps, ~26 byte, 2 ms — **nhanh nhất**.
- Vì sao 16 channel? Stick 4 + AUX nhiều — đủ cho ARM/MODE/AUX/Lock/Failsafe.
- Telemetry đường về (FC → radio): dùng cùng UART half-duplex, hoặc 2 UART. Project chưa hiện thực telemetry.
