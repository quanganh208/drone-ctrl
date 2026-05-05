# Vấn đáp F411_FC4 — phân công 5 thành viên

> Dự án: STM32F411 Flight Controller (firmware bare-metal C, HAL + LL).
> Mục tiêu: mỗi người làm chủ 1 module ~10–15 phút vấn đáp.

## Bản đồ module

| # | Người | Module | File chính | LOC |
|---|---|---|---|---|
| 1 | A | Driver IMU BMI160 qua SPI | `Core/Src/BMI160.c` | ~100 |
| 2 | B | Parser CRSF + USART RX-Interrupt | `Core/Src/stm32f4xx_it.c` (399–484), `usart.c` | ~180 |
| 3 | C | PID + Cascaded MPC + Motor Mixer (PWM) | `PID_Controller.c`, `main.c` (479–576) | ~190 |
| 4 | D | Digital Filter (Biquad/PT1) + IMU pipeline | `Filter.c`, `main.c::IMU_PROCESS` | ~310 |
| 5 | E | AHRS Madgwick + IMU Calibration 6-face | `ARHS.c`, `IMU_CALIBRATE.c` | ~960 |

## Sơ đồ luồng dữ liệu (toàn hệ thống)

```
[BMI160 SPI 1.6kHz]──► IMU_PROCESS ─► Biquad LPF/Notch ─► ARHS_Predict ──┐
                                                             (q, RPY)    │
                                                                         ▼
[ELRS RX UART 420k]──► USART1_IRQ ─► CRSF parse ─► CH[16] ──► RX_PROCESS
                                                                         │
                                                                         ▼
                                                                       MPC()
                                                              ┌──────────┴──────────┐
                                                          ANGLE PID              RATE PID
                                                          (250 Hz)               (500 Hz)
                                                                                    │
                                                                                    ▼
                                                                               Motor Mixer
                                                                          (TIM3/4 OneShot125)
                                                                                    │
                                                                                    ▼
                                                                          [4 ESC PWM 125-250µs]
```

## Kiến thức nền — TẤT CẢ phải thuộc

> Thầy có thể hỏi bất kỳ ai, không phụ thuộc module được giao.

### 1. Phần cứng STM32F411
- Lõi **ARM Cortex-M4F**, 96 MHz, có FPU single-precision (IEEE-754 32-bit).
- Flash 512 KB, SRAM 128 KB.
- **NVIC** 60+ ngắt, 16 mức ưu tiên (0 = cao nhất). Project dùng group 4 (4 bit preempt).

### 2. Clock tree (`main.c::SystemClock_Config` line 437)
```
HSE 8 MHz ──► PLL (M=12, N=96, P=2) ──► SYSCLK 96 MHz
                                       ├─ AHB  96 MHz
                                       ├─ APB1 48 MHz (TIM2/3/4 ×2 = 96 MHz)
                                       └─ APB2 96 MHz (USART1/6, SPI1)
```
- TIM2 prescaler 100−1, period 32-bit max → **counter 1 MHz, wrap ~71 phút** → dùng làm scheduler chính.

### 3. HAL vs LL
- **HAL** (Hardware Abstraction Layer) — gọn, đa-MCU, có overhead. Dùng cho SPI, GPIO, DMA, base TIM.
- **LL** (Low-Layer) — sát register, nhanh hơn ~3–5×. Dùng cho USART (timing-critical, ISR).
- Hỏi: tại sao USART dùng LL? → ISR phải xử lý xong trước khi byte tiếp theo tới (1/420000·10 ≈ 24 µs).

### 4. Kiến trúc super-loop (không RTOS)
```c
while(1){
  IMU_PROCESS();   // tự gating: chỉ chạy khi BMI160 có DRDY
  RX_PROCESS();    // tự gating: chỉ chạy khi crsf_frame_done
  MPC();           // chia 2 sub-rate: 250Hz angle / 500Hz rate
}
```
- Pattern `if (TIM2->CNT - prev > period) { ... }` xử lý unsigned wrap đúng.
- Ưu / nhược super-loop vs RTOS: đơn giản, deterministic latency thấp; nhược là blocking dễ kéo cả hệ thống.

### 5. Bộ nhớ + biến volatile
- `volatile uint8_t IMU_DATA_RDY` — biến chia sẻ ISR ↔ main, **bắt buộc volatile** để compiler không cache vào register.
- `extern uint16_t crsf_channel[16]` — bộ đệm chia sẻ giữa `stm32f4xx_it.c` (writer trong ISR) và `main.c::RX_PROCESS` (reader).

### 6. Câu thầy hay hỏi chung
- **"Nếu tắt FPU thì sao?"** → ARHS + Filter chạy float, mỗi phép nhân ~30 cycle thay vì 1 cycle → vòng PID trễ → bay rung.
- **"Vì sao không dùng `delay()` mà dùng `TIM2->CNT`?"** → `delay()` blocking, TIM2 polling không chặn task khác.
- **"Failsafe ở đâu?"** → CHƯA CÓ. Ngắt CRSF mất 2s thì `crsf_frame_done` không set, motor giữ giá trị cũ → tech debt phải nói thật.
- **"Vì sao 4 motor mixer là `±roll ±pitch ±yaw`?"** → quad-X cấu hình, mỗi motor đóng góp về 3 trục theo dấu vị trí.
- **"Quy ước trục NED hay ENU?"** → project dùng body-frame, output gyro được swap dấu trong `IMU_PROCESS` (line 620–625).

## Cách dùng thư mục

- `01-bmi160-spi.md` — Người A
- `02-crsf-uart-irq.md` — Người B
- `03-pid-cascaded-mixer.md` — Người C
- `04-filter-biquad-pt1.md` — Người D
- `05-ahrs-madgwick-calib.md` — Người E

Mỗi file có: **scope · code-walkthrough · câu hỏi cơ bản · câu hỏi phản biện · bẫy thường gặp**.

## Mẹo trình bày

1. Mở file lên, **chỉ ngón tay vào dòng đang nói** — thầy thấy bạn quen code.
2. Khi không biết: nói **"phần này em chưa làm chủ, nhưng theo em hiểu nó là …"** — đừng bịa.
3. Vẽ tay sơ đồ block + tín hiệu vào/ra trên giấy nháp trước khi nói.
4. Mỗi câu trả lời dài tối đa 30 giây — thầy thường cắt và hỏi sâu.

## Phụ lục — file cấu hình đáng ghi nhớ

| File | Vai trò |
|---|---|
| `F411_FC4.ioc` | STM32CubeMX config — pin map, clock, peripheral |
| `STM32F411CEUX_FLASH.ld` | Linker script — vùng Flash 512KB / SRAM 128KB |
| `Core/Inc/stm32f4xx_hal_conf.h` | Bật/tắt module HAL |
| `Drivers/CMSIS/...` | thư viện ARM math (FFT, ma trận) |
