# Người A — Driver IMU BMI160 qua SPI

## Scope

| | |
|---|---|
| **File** | `Core/Src/BMI160.c` (100 LOC), `Core/Inc/BMI160.h` |
| **Phụ thuộc** | `spi.c`, `gpio.c`, EXTI15_10 trong `stm32f4xx_it.c:502` |
| **Hàm chính** | `BMI160_Init()`, `BMI160_Read()`, `SPI_Read_Register()`, `SPI_Write_Register()` |
| **Vị trí trong hệ thống** | Lớp driver thấp nhất — feed gyro/acc cho Filter → AHRS |

## Phải biết cold

### 1. BMI160 là gì
- IMU 6-DOF: 3 trục gyro (±125…±2000 dps) + 3 trục acc (±2…±16 g).
- Giao tiếp: SPI **hoặc** I2C (project chọn SPI vì tốc độ).
- Project cấu hình: ±8 g, ±2000 dps, ODR 1600 Hz cả gyro và acc.

### 2. SPI 4 dây (full-duplex)
```
MOSI ─► (master out)     CS  active-LOW
MISO ◄─ (master in)      SCK clock từ master
SCK  ─►                  Mode 0 (CPOL=0, CPHA=0) — sample tại sườn lên
```
- Hardware SPI1 trên STM32F411 chân: PA5=SCK, PA6=MISO, PA7=MOSI (xem `spi.c`).
- CS riêng (PA4 hoặc tương đương — `CS_BMI160_GPIO_Port`/`Pin`).

### 3. Quy ước register read/write của BMI160
```c
// Bit 7 = 0 → write   (reg & 0x7F)
// Bit 7 = 1 → read    (reg | 0x80)
SPI_Write_Register(imu, 0x7E, 0x15);  // CMD: gyro normal mode
SPI_Read_Register(imu, 0x00);          // CHIPID → 0xD1
```
Đây là chuẩn của hầu hết IMU/sensor SPI (MPU6050, ICM, LSM…).

### 4. Burst read (BMI160_Read line 71–100)
- 1 transaction, 13 byte:
  - byte 0 = address `0x0C | 0x80` (GYR_DATA_X_LSB + read flag).
  - byte 1–6 = gyro X/Y/Z LSB,MSB (little-endian).
  - byte 7–12 = acc X/Y/Z LSB,MSB.
- Vì sao burst? → Tiết kiệm thời gian CS toggle; dữ liệu **đồng nhất** (không bị lệch frame giữa gyro và acc).

### 5. Scale factor
```c
gyro_dps = raw × 0.001064225  = raw × (2000.0/32768) × (π/180)  → rad/s
acc_g    = raw × 0.000244140625 = raw × 8.0/32768                → g
```
- Project trả ra **rad/s** cho gyro (đã có π/180), trả ra **g** cho acc (chưa nhân 9.81 — nhân ở `IMU_PROCESS` line 623).

### 6. CHIPID handshake
```c
for (uint8_t attempts = 0; attempts < 5; attempts++) {
    HAL_Delay(100);
    imu->chipId = SPI_Read_Register(imu, BMI160_REG_CHIPID);
    if (imu->chipId == 0xD1) break;
}
```
- CHIPID `0xD1` xác nhận đây là BMI160 (BMI088 = 0x1E, MPU6500 = 0x70).
- 5 lần thử để vượt qua khoảng power-up jitter.

### 7. INT1 = Data Ready
- Cấu hình `BMI160_REG_INT_OUT_CTRL` + `INT_MAP1` để khi có sample mới → INT1 pulse.
- Chân INT1 nối tới EXTI line trên STM32 (PA15 trong project).
- ISR: `EXTI15_10_IRQHandler → HAL_GPIO_EXTI_IRQHandler(INT_BMI160_Pin)`.

## Code walkthrough — đọc to lúc vấn đáp

```c
static uint8_t SPI_Read_Register(BMI160_t *imu, uint8_t reg){
    uint8_t tx_data = reg | 0x80;          // (1) set bit read
    uint8_t rx_data;
    HAL_GPIO_WritePin(cs_bank, cs_pin, RESET);   // (2) CS LOW
    HAL_SPI_Transmit(&hspi1, &tx_data, 1, ∞);    // (3) gửi address
    HAL_SPI_Receive (&hspi1, &rx_data, 1, ∞);    // (4) đọc 1 byte
    HAL_GPIO_WritePin(cs_bank, cs_pin, SET);     // (5) CS HIGH
    return rx_data;
}
```

**Điểm chốt khi giải thích:**
- (1) BMI160 dùng bit 7 ở byte address để phân biệt R/W.
- (2)–(5) phải bao quanh transaction — nếu nhả CS giữa chừng, BMI160 hủy lệnh.
- `HAL_MAX_DELAY` = chấp nhận block forever; chấp nhận được vì init chỉ chạy 1 lần.

## Câu hỏi CƠ BẢN

| # | Câu | Hướng trả lời |
|---|---|---|
| 1 | "SPI có mấy dây, vai trò?" | 4 dây MOSI/MISO/SCK/CS, CS active-LOW chọn slave |
| 2 | "BMI160 dùng SPI mode nào?" | Mode 0 (CPOL=0, CPHA=0) — datasheet quy định |
| 3 | "Tại sao bit 7 của address?" | Phân biệt read/write — chuẩn của BMI160 |
| 4 | "Tốc độ SPI bao nhiêu?" | Cấu hình ở `MX_SPI1_Init` — prescaler /8 → 12 Mbit/s (dưới 10 Mbit/s max của BMI160) |
| 5 | "CHIPID dùng làm gì?" | Verify chip đúng + đang sống — cũng để debug khi thay sensor |
| 6 | "Burst read tiết kiệm thời gian thế nào?" | 1 lần CS toggle thay vì 6 lần; gyro+acc cùng frame thời gian |
| 7 | "ODR 1600 Hz, vì sao chọn?" | Dư Nyquist cho dải tần điều khiển (~80 Hz), cho phép notch motor 200 Hz |
| 8 | "raw int16 → đơn vị vật lý?" | scale = full_range / 32768; gyro nhân thêm π/180 vì dùng rad/s |

## Câu hỏi PHẢN BIỆN — thầy hay vặn

### Q1. "Em đang dùng `HAL_SPI_Transmit` blocking. Nếu SPI hỏng (slave không drive MISO), code sẽ làm gì?"
**A:** `HAL_MAX_DELAY` sẽ block vô hạn → **bug nguy hiểm**. Nhược điểm thực sự. Cách khắc phục: thay bằng `HAL_SPI_Transmit_DMA` hoặc đặt timeout cụ thể (vd 10 ms) + watchdog.

### Q2. "Burst read 13 byte qua HAL polling — vì sao không dùng DMA?"
**A:** Project có config DMA SPI1 (xem `extern hdma_spi1_rx/tx` trong `stm32f4xx_it.c:209-211`) nhưng BMI160_Read **vẫn dùng polling**. Đó là **tech debt** — DMA sẽ giảm CPU load lúc đọc IMU từ ~25 µs xuống <1 µs (DMA chạy nền).

### Q3. "Có đảm bảo gyro và acc cùng thời điểm không?"
**A:** BMI160 internally sample gyro/acc ở cùng ODR và đồng bộ. Nhưng burst-read nhanh (~25 µs) coi như cùng frame; lệch nhau <1 sample = <625 µs.

### Q4. "Bit 7 nếu chip đặt khác thì sao?"
**A:** Đây là chuẩn BMI160. Nếu thay chip (ICM42688), phải đổi convention (ICM dùng bit 7 = 1 cũng đọc, nhưng register map khác → cần thiết kế abstract layer).

### Q5. "Tại sao chip-select toggle cần `HAL_Delay(2)` sau write?"
**A:** Một số lệnh PMU (Power Mode Unit) cần thời gian xử lý (vd `PMU_GYR_NORMAL` cần ~80 ms để gyro sẵn sàng). 2 ms là an toàn cho lệnh ngắn; lệnh dài hơn dùng `HAL_Delay(100)` (line 36, 43).

### Q6. "Endianness — gyro/acc raw lưu little hay big endian?"
**A:** Little-endian: `raw[i] = (rx[high] << 8) | rx[low]`. Tức byte LSB trước, MSB sau. Đây là quy ước của BMI160 datasheet section 2.11.

### Q7. "Vì sao dùng `int16_t` rồi cast, không cast trực tiếp `(uint16_t)(rx[1]<<8|rx[0])`?"
**A:** Vì giá trị có dấu (gyro/acc có hướng âm dương). `int16_t` cast giữ đúng bit dấu (sign-extension); `uint16_t` mất thông tin âm.

## Bẫy thường gặp

1. **Nhầm chuẩn read/write của các IMU khác** → luôn check datasheet section "SPI interface".
2. **Không clear pull-up trên CS** → CS không LOW xuống đủ → BMI160 ignore lệnh.
3. **HAL_Delay trong ISR** → freeze (HAL_Delay dùng SysTick, ISR cùng/cao priority sẽ deadlock). Project chỉ dùng trong init, OK.
4. **Quên cấu hình clock SPI1** trong `HAL_SPI_MspInit` → SPI im lặng.
5. **CS đang HIGH khi cấp nguồn** → BMI160 vào I2C mode mặc định. Phải kéo CS LOW 1 lần ngay sau power-up để lock SPI.

## "Nếu bỏ module này thì sao?"

→ Không có dữ liệu IMU → AHRS quaternion đứng im → góc roll/pitch luôn 0 → drone bay không kiểm soát.

## Bonus — câu hỏi mở rộng

- Vẽ giản đồ thời gian CS / SCK / MOSI / MISO khi đọc 1 byte register.
- Phân biệt SPI mode 0/1/2/3 (CPOL × CPHA).
- Tại sao BMI160 cần "soft reset" trước khi cấu hình? (cmd `0xB6`).
- Khác biệt BMI160 vs MPU6050 vs ICM42688 (BMI160 có FIFO 1024 byte, MPU6050 cũ hơn ODR thấp hơn, ICM42688 mới nhất với on-chip AAF).
